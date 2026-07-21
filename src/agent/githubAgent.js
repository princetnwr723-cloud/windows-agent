// src/agent/githubAgent.js
// GitHub integration — read, create, edit files in any repo
// Uses GitHub REST API — no git commands needed!

const os   = require("os");
const path = require("path");
const fs   = require("fs");

const STATE_FILE = path.join(os.homedir(), ".vnus-agent", "github-state.json");

// ── Load/Save GitHub token ────────────────────────────────
function loadGithubState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return { token: null, username: null };
}

function saveGithubState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── GitHub API base ───────────────────────────────────────
async function githubAPI(endpoint, method = "GET", body = null) {
  const state = loadGithubState();
  if (!state.token) throw new Error("GitHub token not set. Use github_auth action first.");

  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${state.token}`,
      "Accept":        "application/vnd.github.v3+json",
      "Content-Type":  "application/json",
      "User-Agent":    "Vnus-Agent/1.0",
    },
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status}: ${err}`);
  }

  return res.status === 204 ? null : await res.json();
}

// ── Set GitHub token ──────────────────────────────────────
async function githubAuth(token) {
  // Verify token works
  const res = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": `Bearer ${token}`,
      "User-Agent":    "Vnus-Agent/1.0",
    },
  });
  if (!res.ok) throw new Error("Invalid GitHub token");
  const user = await res.json();
  saveGithubState({ token, username: user.login });
  console.log(`✅ GitHub authenticated as: ${user.login}`);
  return { success: true, username: user.login };
}

// ── List repos ────────────────────────────────────────────
async function githubListRepos() {
  const repos = await githubAPI("/user/repos?per_page=100&sort=updated");
  return repos.map(r => ({
    name:        r.name,
    fullName:    r.full_name,
    private:     r.private,
    description: r.description,
    language:    r.language,
    updatedAt:   r.updated_at,
    url:         r.html_url,
  }));
}

// ── List files in repo ────────────────────────────────────
async function githubListFiles(owner, repo, filePath = "") {
  const data = await githubAPI(`/repos/${owner}/${repo}/contents/${filePath}`);
  if (Array.isArray(data)) {
    return data.map(f => ({
      name: f.name,
      path: f.path,
      type: f.type, // file or dir
      size: f.size,
      url:  f.html_url,
    }));
  }
  return [{ name: data.name, path: data.path, type: data.type }];
}

// ── Read file from repo ───────────────────────────────────
async function githubReadFile(owner, repo, filePath, branch = "main") {
  try {
    const data = await githubAPI(`/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`);
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return {
      content,
      sha:     data.sha,
      size:    data.size,
      path:    data.path,
      branch,
    };
  } catch (err) {
    // Try master branch if main fails
    if (branch === "main") return githubReadFile(owner, repo, filePath, "master");
    throw err;
  }
}

// ── Create or Update file in repo ────────────────────────
async function githubWriteFile(owner, repo, filePath, content, message, branch = "main") {
  let sha = null;

  // Check if file exists (need sha to update)
  try {
    const existing = await githubReadFile(owner, repo, filePath, branch);
    sha = existing.sha;
  } catch {
    // File doesn't exist — will create new
  }

  const body = {
    message: message || `Update ${filePath} via Vnus Agent`,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (sha) body.sha = sha; // Required for updates

  const result = await githubAPI(`/repos/${owner}/${repo}/contents/${filePath}`, "PUT", body);
  console.log(`✅ GitHub: ${sha ? "Updated" : "Created"} ${filePath} in ${owner}/${repo}`);
  return {
    success: true,
    action:  sha ? "updated" : "created",
    path:    filePath,
    url:     result.content?.html_url,
    commit:  result.commit?.sha,
  };
}

// ── Delete file from repo ─────────────────────────────────
async function githubDeleteFile(owner, repo, filePath, message, branch = "main") {
  const existing = await githubReadFile(owner, repo, filePath, branch);
  await githubAPI(`/repos/${owner}/${repo}/contents/${filePath}`, "DELETE", {
    message: message || `Delete ${filePath} via Vnus Agent`,
    sha:     existing.sha,
    branch,
  });
  console.log(`✅ GitHub: Deleted ${filePath}`);
  return { success: true, path: filePath };
}

// ── Create repo ───────────────────────────────────────────
async function githubCreateRepo(name, description = "", isPrivate = false) {
  const result = await githubAPI("/user/repos", "POST", {
    name,
    description,
    private:    isPrivate,
    auto_init:  true,
  });
  console.log(`✅ GitHub: Created repo ${result.full_name}`);
  return {
    success:  true,
    fullName: result.full_name,
    url:      result.html_url,
    cloneUrl: result.clone_url,
  };
}

// ── Create branch ─────────────────────────────────────────
async function githubCreateBranch(owner, repo, branchName, fromBranch = "main") {
  // Get SHA of source branch
  const ref    = await githubAPI(`/repos/${owner}/${repo}/git/refs/heads/${fromBranch}`);
  const sha    = ref.object.sha;
  await githubAPI(`/repos/${owner}/${repo}/git/refs`, "POST", {
    ref: `refs/heads/${branchName}`,
    sha,
  });
  console.log(`✅ GitHub: Created branch ${branchName}`);
  return { success: true, branch: branchName, from: fromBranch };
}

// ── Create pull request ───────────────────────────────────
async function githubCreatePR(owner, repo, title, body, headBranch, baseBranch = "main") {
  const result = await githubAPI(`/repos/${owner}/${repo}/pulls`, "POST", {
    title,
    body,
    head: headBranch,
    base: baseBranch,
  });
  console.log(`✅ GitHub: Created PR #${result.number}`);
  return {
    success: true,
    number:  result.number,
    url:     result.html_url,
    title:   result.title,
  };
}

// ── List issues ───────────────────────────────────────────
async function githubListIssues(owner, repo, state = "open") {
  const issues = await githubAPI(`/repos/${owner}/${repo}/issues?state=${state}&per_page=50`);
  return issues
    .filter(i => !i.pull_request) // exclude PRs
    .map(i => ({
      number: i.number,
      title:  i.title,
      state:  i.state,
      labels: i.labels.map(l => l.name),
      url:    i.html_url,
    }));
}

// ── Create issue ──────────────────────────────────────────
async function githubCreateIssue(owner, repo, title, body, labels = []) {
  const result = await githubAPI(`/repos/${owner}/${repo}/issues`, "POST", {
    title, body, labels,
  });
  console.log(`✅ GitHub: Created issue #${result.number}`);
  return {
    success: true,
    number:  result.number,
    url:     result.html_url,
  };
}

// ── Get repo info ─────────────────────────────────────────
async function githubGetRepo(owner, repo) {
  const data = await githubAPI(`/repos/${owner}/${repo}`);
  return {
    fullName:     data.full_name,
    description:  data.description,
    language:     data.language,
    stars:        data.stargazers_count,
    forks:        data.forks_count,
    defaultBranch:data.default_branch,
    url:          data.html_url,
    topics:       data.topics,
  };
}

// ── Search in repo ────────────────────────────────────────
async function githubSearch(query, owner = null, repo = null) {
  let q = query;
  if (owner && repo) q += ` repo:${owner}/${repo}`;
  else if (owner)    q += ` user:${owner}`;

  const result = await githubAPI(`/search/code?q=${encodeURIComponent(q)}&per_page=20`);
  return result.items.map(i => ({
    path:       i.path,
    repo:       i.repository.full_name,
    url:        i.html_url,
    score:      i.score,
  }));
}

// ── Clone repo locally ────────────────────────────────────
async function githubCloneLocally(owner, repo, targetDir = null) {
  const { execSync } = require("child_process");
  const state        = loadGithubState();
  const dir          = targetDir || path.join(os.homedir(), "Desktop", repo);
  const cloneUrl     = `https://${state.token}@github.com/${owner}/${repo}.git`;

  if (fs.existsSync(dir)) {
    // Pull latest if exists
    execSync(`git -C "${dir}" pull`, { stdio: "pipe" });
    console.log(`✅ GitHub: Pulled latest for ${owner}/${repo}`);
  } else {
    execSync(`git clone "${cloneUrl}" "${dir}"`, { stdio: "pipe" });
    console.log(`✅ GitHub: Cloned ${owner}/${repo} to ${dir}`);
  }

  return { success: true, path: dir, repo: `${owner}/${repo}` };
}

// ── Commit multiple files at once ─────────────────────────
async function githubCommitMultiple(owner, repo, files, message, branch = "main") {
  // Get latest commit SHA
  const ref      = await githubAPI(`/repos/${owner}/${repo}/git/refs/heads/${branch}`);
  const commitSha = ref.object.sha;
  const commit   = await githubAPI(`/repos/${owner}/${repo}/git/commits/${commitSha}`);
  const treeSha  = commit.tree.sha;

  // Create blobs for each file
  const treeItems = await Promise.all(files.map(async (f) => {
    const blob = await githubAPI(`/repos/${owner}/${repo}/git/blobs`, "POST", {
      content:  Buffer.from(f.content).toString("base64"),
      encoding: "base64",
    });
    return {
      path:    f.path,
      mode:    "100644",
      type:    "blob",
      sha:     blob.sha,
    };
  }));

  // Create new tree
  const newTree = await githubAPI(`/repos/${owner}/${repo}/git/trees`, "POST", {
    base_tree: treeSha,
    tree:      treeItems,
  });

  // Create commit
  const newCommit = await githubAPI(`/repos/${owner}/${repo}/git/commits`, "POST", {
    message,
    tree:    newTree.sha,
    parents: [commitSha],
  });

  // Update branch ref
  await githubAPI(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, "PATCH", {
    sha: newCommit.sha,
  });

  console.log(`✅ GitHub: Committed ${files.length} files to ${owner}/${repo}/${branch}`);
  return {
    success:   true,
    commitSha: newCommit.sha,
    files:     files.map(f => f.path),
    message,
  };
}

module.exports = {
  githubAuth,
  githubListRepos,
  githubListFiles,
  githubReadFile,
  githubWriteFile,
  githubDeleteFile,
  githubCreateRepo,
  githubCreateBranch,
  githubCreatePR,
  githubListIssues,
  githubCreateIssue,
  githubGetRepo,
  githubSearch,
  githubCloneLocally,
  githubCommitMultiple,
  loadGithubState,
};
