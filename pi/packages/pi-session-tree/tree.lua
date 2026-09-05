-- Minimal Neovim sidebar for persistent and live Pi sessions. No plugins or network access.

local uv = vim.uv
local root = os.getenv("PI_SESSION_TREE_ROOT") or vim.fn.getcwd()
local registry_path = os.getenv("PI_SESSION_TREE_REGISTRY")
  or vim.fn.expand("~/.pi/agent/tmux-session-tree.json")
local catalog_path = os.getenv("PI_SESSION_TREE_CATALOG")
  or vim.fn.expand("~/.pi/agent/tmux-session-catalog.json")
local workspace_path = os.getenv("PI_SESSION_TREE_WORKSPACES")
  or vim.fn.expand("~/.pi/agent/tmux-workspaces.json")
local tree_pane = os.getenv("TMUX_PANE") or ""
local sidebar_width = 45
local status_right_margin = 3
local spinner_frames = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
local tree_init_path = debug.getinfo(1, "S").source:gsub("^@", "")

vim.opt.background = "dark"
vim.cmd.colorscheme("default")
vim.opt.number = false
vim.opt.relativenumber = false
vim.opt.signcolumn = "no"
vim.opt.foldcolumn = "0"
vim.opt.cursorline = true
vim.opt.wrap = false
vim.opt.swapfile = false
vim.opt.laststatus = 2
vim.opt.showmode = false
vim.opt.ruler = false
vim.opt.cmdheight = 0
vim.opt.fillchars:append({ eob = " " })
vim.opt.statusline = "  j/k move  ↵ open/reopen  n new  a workspace  r rename  x delete  q quit"

vim.api.nvim_set_hl(0, "PiTreeCursor", { bg = "#303030", ctermbg = 236 })
vim.api.nvim_set_hl(0, "PiTreeSelected", { bg = "#303030", ctermbg = 236 })
vim.api.nvim_set_hl(0, "PiTreeHeader", { fg = "#88f9fe", ctermfg = 14, bold = true })
vim.api.nvim_set_hl(0, "PiTreeRoot", { fg = "#808080", ctermfg = 8 })
vim.api.nvim_set_hl(0, "PiTreeWorking", { fg = "#ffff00", ctermfg = 11, bold = true })
vim.api.nvim_set_hl(0, "PiTreePermission", { fg = "#ff6c6b", ctermfg = 9, bold = true })
vim.api.nvim_set_hl(0, "PiTreeUnread", { fg = "#00ff00", ctermfg = 10, bold = true })
vim.api.nvim_set_hl(0, "PiTreeIdle", { fg = "#666666", ctermfg = 8, bold = true })
vim.api.nvim_set_option_value("winhl", "CursorLine:PiTreeCursor", { win = 0 })

local buffer = vim.api.nvim_get_current_buf()
vim.bo[buffer].buftype = "nofile"
vim.bo[buffer].bufhidden = "wipe"
vim.bo[buffer].swapfile = false
vim.bo[buffer].filetype = "pi-session-tree"
vim.api.nvim_buf_set_name(buffer, "pi://sessions")

local namespace = vim.api.nvim_create_namespace("pi-session-tree")
local entries = {}
local line_to_entry = {}
local line_to_workspace = {}
local selected_pane = nil
local selected_workspace = nil
local cached_live_panes = {}
local live_panes_checked_at = 0
local cached_active_panes = {}
local active_panes_checked_at = 0
local previous_status = {}
local cached_permission_panes = {}
local permission_panes_checked_at = 0
local last_navigation_request = ""
local last_owner = nil

local function tmux(args, timeout)
  local command = { "tmux" }
  vim.list_extend(command, args)
  local result = vim.system(command, { text = true }):wait(timeout or 3000)
  return result.code or 1, result.stdout or "", result.stderr or ""
end

local function enforce_sidebar_width(pane)
  if pane == "" then return end
  tmux({ "resize-pane", "-t", pane, "-x", tostring(sidebar_width) })
end

local function canonical(path)
  return uv.fs_realpath(path) or vim.fs.normalize(path)
end

local canonical_root = canonical(root)

local function inside_root(path)
  local candidate = canonical(path)
  return candidate == canonical_root or candidate:sub(1, #canonical_root + 1) == canonical_root .. "/"
end

local function short_path(path)
  local parts = {}
  for part in canonical(path):gmatch("[^/]+") do table.insert(parts, part) end
  if #parts == 0 then return "/" end
  local visible = {}
  for index = math.max(1, #parts - 2), #parts do table.insert(visible, parts[index]) end
  return table.concat(visible, "/")
end

local function display_root()
  return short_path(canonical_root)
end

local function read_entries(path)
  local file = io.open(path, "r")
  if not file then return {} end
  local content = file:read("*a")
  file:close()
  local ok, decoded = pcall(vim.json.decode, content)
  if not ok or type(decoded) ~= "table" or type(decoded.entries) ~= "table" then return {} end
  return decoded.entries
end

local function read_registry() return read_entries(registry_path) end
local function read_catalog() return read_entries(catalog_path) end

local function atomic_write_json(path, value)
  local directory = vim.fs.dirname(path)
  vim.fn.mkdir(directory, "p")
  local temporary = string.format("%s.tmp-%d-%d", path, vim.fn.getpid(), math.random(1000000))
  local file = assert(io.open(temporary, "w"))
  file:write(vim.json.encode(value), "\n")
  file:close()
  pcall(vim.fn.setfperm, temporary, "rw-------")
  assert(os.rename(temporary, path))
end

local function write_registry(all_entries)
  atomic_write_json(registry_path, { entries = all_entries })
end

local function write_catalog(all_entries)
  atomic_write_json(catalog_path, { entries = all_entries })
end

local function merged_entries()
  local result, positions = {}, {}
  for _, source in ipairs({ read_catalog(), read_registry() }) do
    for _, entry in ipairs(source) do
      local id = type(entry) == "table" and entry.piSessionId or nil
      if id then
        local position = positions[id]
        if position then result[position] = entry
        else
          table.insert(result, entry)
          positions[id] = #result
        end
      end
    end
  end
  return result
end

local function read_workspaces()
  local file = io.open(workspace_path, "r")
  if not file then return {} end
  local content = file:read("*a")
  file:close()
  local ok, decoded = pcall(vim.json.decode, content)
  if not ok or type(decoded) ~= "table" or type(decoded.workspaces) ~= "table" then return {} end
  local unique, result = {}, {}
  for _, workspace in ipairs(decoded.workspaces) do
    if type(workspace) == "string" then
      local path = canonical(workspace)
      if not unique[path] and vim.fn.isdirectory(path) == 1 then
        unique[path] = true
        table.insert(result, path)
      end
    end
  end
  table.sort(result)
  return result
end

local function register_workspace(path)
  path = canonical(path)
  local workspaces = read_workspaces()
  for _, existing in ipairs(workspaces) do
    if existing == path then return path end
  end
  table.insert(workspaces, path)
  table.sort(workspaces)
  atomic_write_json(workspace_path, { workspaces = workspaces })
  return path
end

local function live_panes()
  local now = uv.now()
  if now - live_panes_checked_at < 2000 then return cached_live_panes end
  live_panes_checked_at = now
  local code, stdout = tmux({ "list-panes", "-a", "-F", "#{pane_id}" })
  if code ~= 0 then return cached_live_panes end
  local live = {}
  for pane in stdout:gmatch("[^\r\n]+") do live[pane] = true end
  cached_live_panes = live
  return live
end

local function process_alive(pid)
  pid = tonumber(pid)
  if not pid or pid <= 0 then return false end
  local ok, result = pcall(uv.kill, pid, 0)
  return ok and result == 0
end

local function active_panes()
  local now = uv.now()
  if now - active_panes_checked_at < 500 then return cached_active_panes end
  active_panes_checked_at = now
  local code, stdout = tmux({ "list-clients", "-F", "#{pane_id}" })
  if code ~= 0 then return cached_active_panes end
  local active = {}
  for pane in stdout:gmatch("[^\r\n]+") do active[pane] = true end
  cached_active_panes = active
  return active
end

local function owner_pane()
  local _, stdout = tmux({ "show-options", "-p", "-v", "-t", tree_pane, "@pi_session_tree_owner" })
  return vim.trim(stdout)
end

local function display_name(entry)
  local name = type(entry.name) == "string" and vim.trim(entry.name) or ""
  if name == "" then return (entry.topic or "기타") .. " / 이름 생성 중" end
  if not name:find(" / ", 1, true) then return (entry.topic or "기타") .. " / " .. name end
  return name
end

local function permission_panes()
  local now = uv.now()
  if now - permission_panes_checked_at < 300 then return cached_permission_panes end
  permission_panes_checked_at = now
  local code, stdout = tmux({ "list-panes", "-a", "-F", "#{pane_id}\t#{@pi_permission_waiting}" }, 300)
  if code ~= 0 then return cached_permission_panes end
  local waiting = {}
  for line in stdout:gmatch("[^\r\n]+") do
    local pane, state = line:match("^([^\t]+)\t(.*)$")
    local publisher_pid = vim.trim(state or ""):match("^mcp:(%d+)$")
    if pane and publisher_pid and process_alive(publisher_pid) then waiting[pane] = true end
  end
  cached_permission_panes = waiting
  return waiting
end

local function pane_waits_for_permission(entry)
  return entry.live == true
    and type(entry.tmuxPaneId) == "string"
    and permission_panes()[entry.tmuxPaneId] == true
end

local function status_for(entry, owner)
  if not entry.live then return "·", "PiTreeIdle" end
  if pane_waits_for_permission(entry) then return "●", "PiTreePermission" end
  if entry.status == "working" then
    local index = math.floor(uv.now() / 120) % #spinner_frames + 1
    return spinner_frames[index], "PiTreeWorking"
  end
  if entry.unread then return "●", "PiTreeUnread" end
  return "○", "PiTreeIdle"
end

local function folder_label(cwd)
  return short_path(cwd)
end

local topic_priority = { ["개발"] = 1, ["마케팅"] = 2, ["분석"] = 3 }

local function entry_topic(entry)
  local topic = type(entry.topic) == "string" and vim.trim(entry.topic) or ""
  if topic ~= "" then return topic end
  local name = type(entry.name) == "string" and entry.name or ""
  return vim.trim(name:match("^(.-)%s*/") or "기타")
end

local function topic_order(topic)
  if topic == "기타" then return 5 end
  return topic_priority[topic] or 4
end

local function entry_before(a, b)
  local a_topic, b_topic = entry_topic(a), entry_topic(b)
  local a_order, b_order = topic_order(a_topic), topic_order(b_topic)
  if a_order ~= b_order then return a_order < b_order end
  -- Unlisted/custom topics share one tier but remain grouped deterministically.
  if a_topic ~= b_topic then return a_topic < b_topic end
  -- Preserve creation order only within the same topic.
  local a_created = type(a.createdAt) == "string" and a.createdAt or (a.piSessionId or "")
  local b_created = type(b.createdAt) == "string" and b.createdAt or (b.piSessionId or "")
  if a_created ~= b_created then return a_created < b_created end
  return (a.piSessionId or "") < (b.piSessionId or "")
end

local function truncate_display(text, maximum)
  if vim.fn.strdisplaywidth(text) <= maximum then return text end
  local result = ""
  for index = 0, vim.fn.strchars(text) - 1 do
    local character = vim.fn.strcharpart(text, index, 1)
    if vim.fn.strdisplaywidth(result .. character .. "…") > maximum then break end
    result = result .. character
  end
  return result .. "…"
end

local function refresh()
  if not vim.api.nvim_buf_is_valid(buffer) then return end
  local live = live_panes()
  local active = active_panes()
  local registry = merged_entries()
  local workspaces = read_workspaces()
  local workspace_set = {}
  for _, workspace in ipairs(workspaces) do workspace_set[canonical(workspace)] = true end
  local next_entries = {}
  local registry_changed = false

  for _, entry in ipairs(registry) do
    local entry_cwd = type(entry) == "table" and type(entry.cwd) == "string" and canonical(entry.cwd) or nil
    local session_exists = type(entry.sessionFile) == "string" and vim.fn.filereadable(entry.sessionFile) == 1
    entry.live = live[entry.tmuxPaneId] == true and process_alive(entry.pid)
    if entry_cwd and session_exists and (inside_root(entry_cwd) or workspace_set[entry_cwd]) then
      local previous = previous_status[entry.piSessionId]
      if entry.live and active[entry.tmuxPaneId] and entry.unread then
        entry.unread = false
        registry_changed = true
      elseif entry.live and previous == "working" and entry.status ~= "working" and not active[entry.tmuxPaneId] then
        entry.unread = true
        registry_changed = true
      end
      previous_status[entry.piSessionId] = entry.status
      table.insert(next_entries, entry)
    end
  end
  if registry_changed then pcall(write_registry, registry) end

  local owner = owner_pane()
  local _, active_value = tmux({ "display-message", "-p", "-t", tree_pane, "#{pane_active}" })
  local tree_is_active = vim.trim(active_value) == "1"
  if owner ~= "" and (owner ~= last_owner or not tree_is_active) then
    selected_pane = owner
    selected_workspace = nil
  end
  last_owner = owner
  local groups_by_cwd = {}
  local groups = {}
  for _, workspace in ipairs(workspaces) do
    local key = canonical(workspace)
    local group = { cwd = key, label = folder_label(key), entries = {}, has_owner = false, registered = true }
    groups_by_cwd[key] = group
    table.insert(groups, group)
  end
  for _, entry in ipairs(next_entries) do
    local key = canonical(entry.cwd)
    local group = groups_by_cwd[key]
    if not group then
      group = { cwd = key, label = folder_label(key), entries = {}, has_owner = false, registered = false }
      groups_by_cwd[key] = group
      table.insert(groups, group)
    end
    table.insert(group.entries, entry)
    if entry.live and entry.tmuxPaneId == owner then group.has_owner = true end
  end
  table.sort(groups, function(a, b) return a.label < b.label end)
  entries = {}
  for _, group in ipairs(groups) do
    table.sort(group.entries, entry_before)
    for _, entry in ipairs(group.entries) do table.insert(entries, entry) end
  end

  local pane_width = vim.api.nvim_win_get_width(0)
  local width = math.max(12, pane_width - 2)
  local lines = {
    " WORKSPACES",
    " " .. display_root(),
    " " .. string.rep("─", width),
    "",
  }
  local new_line_to_entry = {}
  local new_line_to_workspace = {}
  local group_lines = {}
  local icon_columns = {}
  local selected_line = nil
  local session_index = 0
  local number_width = math.max(1, #tostring(#entries))

  for group_index, group in ipairs(groups) do
    table.insert(lines, "  " .. group.label)
    group_lines[#lines] = true
    new_line_to_workspace[#lines] = group.cwd
    if selected_workspace == group.cwd then selected_line = #lines end
    for _, entry in ipairs(group.entries) do
      session_index = session_index + 1
      local icon = status_for(entry, owner)
      local prefix = string.format("    %" .. number_width .. "d ", session_index)
      local name_width = math.max(1, pane_width - vim.fn.strdisplaywidth(prefix) - vim.fn.strdisplaywidth(icon) - status_right_margin - 1)
      local left = prefix .. truncate_display(display_name(entry), name_width)
      local padding = string.rep(" ", math.max(1, pane_width - vim.fn.strdisplaywidth(left) - vim.fn.strdisplaywidth(icon) - status_right_margin))
      local row = left .. padding .. icon .. string.rep(" ", status_right_margin)
      table.insert(lines, row)
      new_line_to_entry[#lines] = entry
      icon_columns[#lines] = { start = #left + #padding, finish = #left + #padding + #icon }
      if entry.tmuxPaneId == selected_pane then selected_line = #lines end
    end
    if #group.entries == 0 then table.insert(lines, "    ○ 세션 없음") end
    if group_index < #groups then table.insert(lines, "") end
  end
  if #groups == 0 then table.insert(lines, "    ○ 등록된 workspace 없음") end

  if not selected_line then
    for line, entry in pairs(new_line_to_entry) do
      if entry.tmuxPaneId == owner then selected_line = line break end
    end
  end
  if not selected_line then
    local available = {}
    for line, _ in pairs(new_line_to_entry) do table.insert(available, line) end
    for line, _ in pairs(new_line_to_workspace) do table.insert(available, line) end
    table.sort(available)
    selected_line = available[1]
  end

  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable = false
  line_to_entry = new_line_to_entry
  line_to_workspace = new_line_to_workspace

  vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
  vim.api.nvim_buf_add_highlight(buffer, namespace, "PiTreeHeader", 0, 1, -1)
  vim.api.nvim_buf_add_highlight(buffer, namespace, "PiTreeRoot", 1, 1, -1)
  vim.api.nvim_buf_add_highlight(buffer, namespace, "PiTreeIdle", 2, 1, -1)
  for line, _ in pairs(group_lines) do
    vim.api.nvim_buf_add_highlight(buffer, namespace, "Directory", line - 1, 2, -1)
  end
  for line, entry in pairs(line_to_entry) do
    local _, highlight = status_for(entry, owner)
    local columns = icon_columns[line]
    vim.api.nvim_buf_add_highlight(buffer, namespace, highlight, line - 1, columns.start, columns.finish)
  end
  if selected_line then
    vim.api.nvim_buf_add_highlight(buffer, namespace, "PiTreeSelected", selected_line - 1, 0, -1)
  end

  if selected_line then
    if line_to_entry[selected_line] then
      selected_pane = line_to_entry[selected_line].tmuxPaneId
      selected_workspace = nil
    elseif line_to_workspace[selected_line] then
      selected_workspace = line_to_workspace[selected_line]
      selected_pane = nil
    end
    pcall(vim.api.nvim_win_set_cursor, 0, { selected_line, 0 })
  end
end

local function action_lines()
  local result = {}
  for line, _ in pairs(line_to_entry) do table.insert(result, line) end
  table.sort(result)
  return result
end

local function move_selection(delta)
  local lines = action_lines()
  if #lines == 0 then return end
  local current = vim.api.nvim_win_get_cursor(0)[1]
  local position = nil
  for index, line in ipairs(lines) do
    if line == current then position = index break end
  end
  if position then
    position = math.max(1, math.min(#lines, position + delta))
  elseif delta > 0 then
    position = #lines
    for index, line in ipairs(lines) do
      if line > current then position = index break end
    end
  else
    position = 1
    for index = #lines, 1, -1 do
      if lines[index] < current then position = index break end
    end
  end
  local line = lines[position]
  vim.api.nvim_win_set_cursor(0, { line, 0 })
  selected_pane = line_to_entry[line].tmuxPaneId
  selected_workspace = nil
end

local function entry_under_cursor()
  return line_to_entry[vim.api.nvim_win_get_cursor(0)[1]]
end

local function target_coordinates(entry)
  return string.format("%s:%s", entry.tmuxSession, entry.tmuxWindow)
end

local function mark_read(entry)
  local all_entries = read_registry()
  for _, candidate in ipairs(all_entries) do
    if candidate.piSessionId == entry.piSessionId then candidate.unread = false end
  end
  pcall(write_registry, all_entries)
  entry.unread = false
end

local function ensure_tree_for(entry)
  local target_window = target_coordinates(entry)
  local _, panes = tmux({ "list-panes", "-t", target_window, "-F", "#{pane_id}\t#{@pi_session_tree}" })
  for line in panes:gmatch("[^\r\n]+") do
    local pane, marker = line:match("^(%%[^\t]+)\t(.*)$")
    if marker == "1" then
      tmux({ "set-option", "-p", "-t", pane, "@pi_session_tree_owner", entry.tmuxPaneId })
      enforce_sidebar_width(pane)
      return pane
    end
  end

  local nvim = vim.fn.exepath("nvim")
  if nvim == "" then return nil end
  local command = string.format("exec %s --clean -n -u %s", vim.fn.shellescape(nvim), vim.fn.shellescape(tree_init_path))
  local code, stdout, stderr = tmux({
    "split-window", "-d", "-b", "-h", "-l", tostring(sidebar_width),
    "-t", entry.tmuxPaneId, "-c", entry.cwd or canonical_root,
    "-e", "PI_SESSION_TREE_ROOT=" .. canonical_root,
    "-e", "PI_SESSION_TREE_REGISTRY=" .. registry_path,
    "-e", "PI_SESSION_TREE_CATALOG=" .. catalog_path,
    "-e", "PI_SESSION_TREE_WORKSPACES=" .. workspace_path,
    "-P", "-F", "#{pane_id}", command,
  })
  local pane = vim.trim(stdout)
  if code ~= 0 or not pane:match("^%%") then
    vim.notify(stderr ~= "" and stderr or "Could not prepare target session tree", vim.log.levels.ERROR)
    return nil
  end
  tmux({ "set-option", "-p", "-t", pane, "@pi_session_tree", "1" })
  tmux({ "set-option", "-p", "-t", pane, "@pi_session_tree_owner", entry.tmuxPaneId })
  tmux({ "set-option", "-p", "-t", pane, "@pi_session_tree_root", canonical_root })
  vim.wait(600, function()
    local _, ready = tmux({ "show-options", "-p", "-v", "-t", pane, "@pi_session_tree_ready" }, 200)
    return vim.trim(ready) == "1"
  end, 20)
  vim.wait(50)
  return pane
end

local function launch_session(entry)
  if type(entry.sessionFile) ~= "string" or vim.fn.filereadable(entry.sessionFile) ~= 1 then
    vim.notify("Session file no longer exists", vim.log.levels.ERROR)
    return nil
  end
  local pi = vim.fn.exepath("pi")
  if pi == "" then vim.notify("pi executable not found", vim.log.levels.ERROR) return nil end
  local _, session = tmux({ "display-message", "-p", "-t", tree_pane, "#S" })
  session = vim.trim(session)
  local command = string.format(
    "exec %s --tui-mode regular --session %s",
    vim.fn.shellescape(pi), vim.fn.shellescape(entry.sessionFile)
  )
  local code, stdout, stderr = tmux({
    "new-window", "-d", "-P", "-F", "#S\t#I\t#{pane_id}\t#{pane_pid}",
    "-t", session .. ":", "-c", entry.cwd, "-n", "pi-session", command,
  }, 5000)
  if code ~= 0 then
    vim.notify(stderr ~= "" and stderr or "Could not reopen Pi session", vim.log.levels.ERROR)
    return nil
  end
  local tmux_session, tmux_window, pane, pid = vim.trim(stdout):match("^([^\t]+)\t([^\t]+)\t([^\t]+)\t(%d+)$")
  if not pane then return nil end
  entry.tmuxSession = tmux_session
  entry.tmuxWindow = tmux_window
  entry.tmuxPaneId = pane
  entry.pid = tonumber(pid)
  entry.status = "idle"
  entry.unread = false
  entry.live = true
  local all_entries = read_registry()
  for _, candidate in ipairs(all_entries) do
    if candidate.piSessionId == entry.piSessionId then
      for key, value in pairs(entry) do
        if key ~= "live" then candidate[key] = value end
      end
    end
  end
  pcall(write_registry, all_entries)
  live_panes_checked_at = 0
  return entry
end

local function normalize_target_vim_mode(entry, wait_for_startup)
  local function read_state()
    local _, capture = tmux({ "capture-pane", "-p", "-t", entry.tmuxPaneId }, 300)
    local lines = vim.split(capture, "\n", { plain = true })
    for index = #lines, 1, -1 do
      local line = lines[index]
      if line:find("Weekly Usage Limit:", 1, true) then
        local left = vim.trim(vim.split(line, "Thinking:", { plain = true })[1] or "")
        if left == "" or left == "NORMAL" then return "normal" end
        if left:find("INSERT", 1, true) then return "insert" end
        if left:find("VISUAL", 1, true) then return "visual" end
        if vim.startswith(left, ":") then return "ex" end
        return "pending"
      end
    end
    local _, value = tmux({ "show-options", "-p", "-v", "-t", entry.tmuxPaneId, "@pi_vim_state" }, 200)
    return vim.trim(value)
  end
  local state = read_state()
  if state == "" and wait_for_startup then
    vim.wait(2500, function()
      state = read_state()
      return state ~= ""
    end, 25)
  end
  if state ~= "" and state ~= "normal" then
    tmux({ "send-keys", "-t", entry.tmuxPaneId, "Escape" })
  end
end

local function move_tree_and_focus(entry)
  local launched = not entry.live
  local wait_for_startup = launched or entry.waitForStartup == true
  if launched then
    entry = launch_session(entry)
    if not entry then return end
  end
  mark_read(entry)
  -- A brand-new Pi starts in INSERT. Preserve that initial editor state instead
  -- of sending Escape during the tree's startup handshake. Existing live or
  -- reopened sessions still normalize to NORMAL when explicitly activated.
  if entry.preserveInitialInsert ~= true then
    normalize_target_vim_mode(entry, wait_for_startup)
  end
  local owner = owner_pane()
  if entry.tmuxPaneId == owner then
    tmux({ "select-pane", "-t", entry.tmuxPaneId })
    return
  end

  local target_window = target_coordinates(entry)
  if not ensure_tree_for(entry) then return end

  local _, client = tmux({ "display-message", "-p", "-t", tree_pane, "#{client_tty}" })
  client = vim.trim(client)
  local switch_args = { "switch-client" }
  if client ~= "" then vim.list_extend(switch_args, { "-c", client }) end
  vim.list_extend(switch_args, { "-t", target_window })
  tmux(switch_args)
  tmux({ "select-pane", "-t", entry.tmuxPaneId })
end

local function open_selected()
  local entry = entry_under_cursor()
  if entry then move_tree_and_focus(entry) end
end

local function choose_workspace(prompt, default)
  local value = vim.fn.input({ prompt = prompt, default = default, completion = "dir" })
  value = vim.trim(vim.fn.expand(value))
  if value == "" then return nil end
  if not vim.startswith(value, "/") then value = canonical_root .. "/" .. value end
  value = vim.fs.normalize(value)
  if vim.fn.isdirectory(value) ~= 1 then
    if vim.fn.confirm("Create folder " .. value .. "?", "&No\n&Yes", 1) ~= 2 then return nil end
    if vim.fn.mkdir(value, "p") ~= 1 and vim.fn.isdirectory(value) ~= 1 then
      vim.notify("Could not create folder: " .. value, vim.log.levels.ERROR)
      return nil
    end
  end
  return register_workspace(value)
end

local function add_workspace()
  local workspace = choose_workspace("Workspace folder: ", canonical_root .. "/")
  if workspace then
    selected_workspace = workspace
    selected_pane = nil
    vim.notify("Workspace registered: " .. workspace, vim.log.levels.INFO)
    refresh()
  end
end

local function new_session()
  local pi = vim.fn.exepath("pi")
  if pi == "" then vim.notify("pi executable not found", vim.log.levels.ERROR) return end
  local selected = entry_under_cursor()
  local selected_group = line_to_workspace[vim.api.nvim_win_get_cursor(0)[1]]
  local default_workspace = selected_group or (selected and canonical(selected.cwd)) or canonical_root
  local workspace = choose_workspace("New Pi folder: ", default_workspace)
  if not workspace then return end
  local _, session = tmux({ "display-message", "-p", "-t", tree_pane, "#S" })
  session = vim.trim(session)
  local command = string.format("exec %s --tui-mode regular", vim.fn.shellescape(pi))
  local code, stdout, stderr = tmux({
    "new-window", "-d", "-P", "-F", "#S\t#I\t#{pane_id}\t#{pane_pid}",
    "-t", session .. ":", "-c", workspace, "-n", "pi-new", command,
  })
  if code ~= 0 then vim.notify(stderr ~= "" and stderr or "Could not create Pi session", vim.log.levels.ERROR) return end
  local tmux_session, tmux_window, pane, pid = vim.trim(stdout):match("^([^\t]+)\t([^\t]+)\t([^\t]+)\t(%d+)$")
  if pane then
    local now = os.date("!%Y-%m-%dT%H:%M:%SZ")
    local pending = {
      piSessionId = "pending:" .. pane,
      named = false,
      status = "idle",
      unread = false,
      cwd = workspace,
      tmuxSession = tmux_session,
      tmuxWindow = tmux_window,
      tmuxPaneId = pane,
      pid = tonumber(pid) or 0,
      createdAt = now,
      lastSeen = now,
    }
    local entries = read_registry()
    local replaced = false
    for index, candidate in ipairs(entries) do
      if candidate.piSessionId == pending.piSessionId then
        entries[index] = pending
        replaced = true
        break
      end
    end
    if not replaced then table.insert(entries, pending) end
    write_registry(entries)
    live_panes_checked_at = 0
    refresh()
    move_tree_and_focus({
      tmuxSession = tmux_session,
      tmuxWindow = tmux_window,
      tmuxPaneId = pane,
      cwd = workspace,
      live = true,
      waitForStartup = true,
      preserveInitialInsert = true,
    })
  end
end

local function rename_selected()
  local entry = entry_under_cursor()
  if not entry then return end
  local current_name = display_name(entry)
  local edited = vim.trim(vim.fn.input("이름 (분류 / 내용): ", current_name))
  if edited == "" then return end
  local topic, summary = edited:match("^(.-)%s*/%s*(.-)$")
  topic = topic and vim.trim(topic:gsub("%s+", " "):gsub("/", " ")) or ""
  summary = summary and vim.trim(summary:gsub("%s+", " "):gsub("/", " ")) or ""
  if topic == "" or summary == "" then
    vim.notify("이름은 '분류 / 내용' 형식이어야 합니다", vim.log.levels.ERROR)
    return
  end
  local name = topic .. " / " .. summary
  local all_entries = merged_entries()
  for _, candidate in ipairs(all_entries) do
    if candidate.piSessionId == entry.piSessionId then
      candidate.topic = topic
      candidate.named = true
      candidate.name = name
    end
  end
  local ok, error = pcall(function()
    write_catalog(all_entries)
    write_registry(all_entries)
  end)
  if not ok then vim.notify(tostring(error), vim.log.levels.ERROR) return end
  if entry.live then tmux({ "rename-window", "-t", entry.tmuxPaneId, name }) end
  selected_pane = entry.tmuxPaneId
  refresh()
end

local function delete_selected()
  local entry = entry_under_cursor()
  if not entry then return end
  local prompt = "Delete session permanently?\n" .. display_name(entry)
  if vim.fn.confirm(prompt, "&No\n&Delete", 1) ~= 2 then return end

  -- Stop the Pi process before moving its append-only session file. Keep this
  -- tree pane alive when deleting its owner so the user can select another row.
  if entry.live then
    local _, pane_rows = tmux({
      "list-panes", "-a", "-F", "#{pane_id}\t#{@pi_session_tree_owner}",
    })
    for line in pane_rows:gmatch("[^\r\n]+") do
      local pane, owner = line:match("^(%%[^\t]+)\t(.*)$")
      if pane and owner == entry.tmuxPaneId and pane ~= tree_pane then
        tmux({ "kill-pane", "-t", pane })
      end
    end
    tmux({ "kill-pane", "-t", entry.tmuxPaneId })
    if entry.tmuxPaneId == owner_pane() then
      tmux({ "set-option", "-p", "-u", "-t", tree_pane, "@pi_session_tree_owner" })
    end
    vim.wait(100)
  end

  local deleted = false
  local trash = vim.fn.exepath("trash")
  if trash ~= "" then
    local result = vim.system({ trash, entry.sessionFile }, { text = true }):wait(5000)
    deleted = result.code == 0
    if not deleted then vim.notify(result.stderr or "Could not trash session", vim.log.levels.ERROR) end
  else
    deleted = os.remove(entry.sessionFile) ~= nil
    if not deleted then vim.notify("Could not delete session file", vim.log.levels.ERROR) end
  end
  if not deleted then return end

  local kept = {}
  for _, candidate in ipairs(merged_entries()) do
    if candidate.piSessionId ~= entry.piSessionId then table.insert(kept, candidate) end
  end
  pcall(function()
    write_catalog(kept)
    write_registry(kept)
  end)
  selected_pane = nil
  live_panes_checked_at = 0
  refresh()
end

local function close_tree() vim.cmd("qa!") end

local function session_tab(direction, requested_count)
  local lines = {}
  for line, _ in pairs(line_to_entry) do table.insert(lines, line) end
  table.sort(lines)
  if #lines == 0 then return end

  local count = type(requested_count) == "number" and math.floor(requested_count) or vim.v.count
  local current_line = vim.api.nvim_win_get_cursor(0)[1]
  local current_index = 1
  for index, line in ipairs(lines) do
    if line == current_line or line_to_entry[line].tmuxPaneId == owner_pane() then
      current_index = index
      if line == current_line then break end
    end
  end

  local target_index
  if direction == 1 and count > 0 then
    target_index = math.min(count, #lines)
  elseif direction == 1 then
    target_index = current_index % #lines + 1
  else
    local steps = count > 0 and count or 1
    target_index = ((current_index - steps - 1) % #lines) + 1
  end

  local target_line = lines[target_index]
  vim.api.nvim_win_set_cursor(0, { target_line, 0 })
  selected_pane = line_to_entry[target_line].tmuxPaneId
  selected_workspace = nil
  move_tree_and_focus(line_to_entry[target_line])
end

local map_options = { buffer = buffer, silent = true, nowait = true }
vim.keymap.set("n", "j", function() move_selection(1) end, map_options)
vim.keymap.set("n", "k", function() move_selection(-1) end, map_options)
vim.keymap.set("n", "g", function()
  local lines = action_lines()
  if lines[1] then
    vim.api.nvim_win_set_cursor(0, { lines[1], 0 })
    selected_pane = line_to_entry[lines[1]] and line_to_entry[lines[1]].tmuxPaneId or nil
    selected_workspace = line_to_workspace[lines[1]]
  end
end, map_options)
vim.keymap.set("n", "G", function()
  local lines = action_lines()
  if lines[#lines] then
    vim.api.nvim_win_set_cursor(0, { lines[#lines], 0 })
    selected_pane = line_to_entry[lines[#lines]] and line_to_entry[lines[#lines]].tmuxPaneId or nil
    selected_workspace = line_to_workspace[lines[#lines]]
  end
end, map_options)
vim.keymap.set("n", "<CR>", open_selected, map_options)
vim.keymap.set("n", "l", open_selected, map_options)
vim.keymap.set("n", "<LeftMouse>", function()
  local mouse = vim.fn.getmousepos()
  if mouse.winid ~= vim.api.nvim_get_current_win() or mouse.line < 1 then return end
  vim.api.nvim_win_set_cursor(0, { mouse.line, 0 })
  open_selected()
end, map_options)
vim.keymap.set("n", "gt", function() session_tab(1) end, map_options)
vim.keymap.set("n", "gT", function() session_tab(-1) end, map_options)
vim.keymap.set("n", "n", new_session, map_options)
vim.keymap.set("n", "a", add_workspace, map_options)
vim.keymap.set("n", "r", rename_selected, map_options)
vim.keymap.set("n", "x", delete_selected, map_options)
vim.keymap.set("n", "q", close_tree, map_options)
vim.keymap.set("n", "<Esc>", close_tree, map_options)

vim.api.nvim_create_autocmd("VimResized", {
  callback = function()
    vim.schedule(function() enforce_sidebar_width(tree_pane) end)
  end,
})

vim.api.nvim_create_autocmd("CursorMoved", {
  buffer = buffer,
  callback = function()
    local line = vim.api.nvim_win_get_cursor(0)[1]
    local entry = line_to_entry[line]
    if entry then
      selected_pane = entry.tmuxPaneId
      selected_workspace = nil
    elseif line_to_workspace[line] then
      selected_workspace = line_to_workspace[line]
      selected_pane = nil
    end
  end,
})

local function process_navigation_request()
  local _, raw = tmux({ "show-options", "-p", "-v", "-t", tree_pane, "@pi_session_tree_navigation" })
  raw = vim.trim(raw)
  if raw == "" or raw == last_navigation_request then return end
  last_navigation_request = raw
  local ok, request = pcall(vim.json.decode, raw)
  if not ok or type(request) ~= "table" then return end
  local count = type(request.count) == "number" and request.count or nil
  if request.direction == 1 then session_tab(1, count)
  elseif request.direction == -1 then session_tab(-1, count) end
end

register_workspace(canonical_root)
enforce_sidebar_width(tree_pane)
refresh()
tmux({ "set-option", "-p", "-t", tree_pane, "@pi_session_tree_ready", "1" })
local timer = uv.new_timer()
timer:start(250, 250, vim.schedule_wrap(function()
  refresh()
  process_navigation_request()
end))
vim.api.nvim_create_autocmd("VimLeavePre", {
  once = true,
  callback = function()
    if timer then timer:stop(); timer:close(); timer = nil end
  end,
})
