import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export type WorkspaceTargetType = "organization" | "project"

export type WorkspaceOrganization = {
  id: string
  name: string
  path?: string
  tasksFile?: string
  icon?: string
  accent?: string
}

export type WorkspaceProject = {
  id: string
  name: string
  organizationId?: string
  path: string
  tasksFile?: string
  icon?: string
  accent?: string
}

export type WorkspaceRegistry = {
  schemaVersion: 2
  activeTargetId?: string
  organizations: WorkspaceOrganization[]
  projects: WorkspaceProject[]
}

export type WorkspaceRegistryOptions = {
  homeDir?: string
  registryPath?: string
}

export type EnsureWorkspaceRegistryOptions = WorkspaceRegistryOptions & {
  cwd?: string
  addProjectPath?: string
  organizationId?: string
  organizationName?: string
  organizationPath?: string
  projectId?: string
  projectName?: string
  addCurrentIfTasks?: boolean
}

export type UpdateWorkspaceTargetInput = {
  targetId: string
  organizationId?: string
  organizationName?: string
  organizationPath?: string
  projectId?: string
  projectName?: string
  projectPath?: string
}

export function getMapctxHome(options: WorkspaceRegistryOptions = {}): string {
  if (options.homeDir) return path.resolve(options.homeDir)
  return path.resolve(process.env.MAPCTX_HOME || path.join(os.homedir(), ".mapctx"))
}

export function getGlobalRegistryPath(options: WorkspaceRegistryOptions = {}): string {
  if (options.registryPath) return path.resolve(options.registryPath)
  return path.join(getMapctxHome(options), "projects.json")
}

export function targetId(type: WorkspaceTargetType, id: string): string {
  return `${type}:${id}`
}

export function createEmptyWorkspaceRegistry(): WorkspaceRegistry {
  return {
    schemaVersion: 2,
    activeTargetId: undefined,
    organizations: [],
    projects: []
  }
}

export function readWorkspaceRegistry(options: WorkspaceRegistryOptions = {}): WorkspaceRegistry {
  const registryPath = getGlobalRegistryPath(options)
  if (!fs.existsSync(registryPath)) return createEmptyWorkspaceRegistry()

  const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    schemaVersion?: unknown
    activeTargetId?: unknown
    activeProjectId?: unknown
    organizations?: unknown
    projects?: unknown
  }

  const organizations = parseOrganizations(parsed.organizations)
  const projects = parseProjects(parsed.projects)
  const activeTargetId = normalizeActiveTargetId(parsed.activeTargetId, parsed.activeProjectId, organizations, projects)

  return {
    schemaVersion: 2,
    activeTargetId,
    organizations,
    projects
  }
}

export function writeWorkspaceRegistry(registry: WorkspaceRegistry, options: WorkspaceRegistryOptions = {}): string {
  const registryPath = getGlobalRegistryPath(options)
  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8")
  return registryPath
}

export function ensureWorkspaceRegistry(options: EnsureWorkspaceRegistryOptions = {}): {
  registry: WorkspaceRegistry
  registryPath: string
  addedProject?: WorkspaceProject
} {
  const registryPath = getGlobalRegistryPath(options)
  let registry = readWorkspaceRegistry(options)
  let addedProject: WorkspaceProject | undefined

  const cwd = path.resolve(options.cwd || process.cwd())
  const candidate = options.addProjectPath
    ? path.resolve(cwd, options.addProjectPath)
    : options.addCurrentIfTasks
      ? findTasksRoot(cwd)
      : undefined

  if (candidate) {
    const result = addProjectToRegistry(registry, candidate, options)
    registry = result.registry
    addedProject = result.project
  }

  writeWorkspaceRegistry(registry, options)
  return { registry, registryPath, addedProject }
}

export function addProjectToRegistry(
  registry: WorkspaceRegistry,
  projectPath: string,
  options: Pick<EnsureWorkspaceRegistryOptions, "organizationId" | "organizationName" | "organizationPath" | "projectId" | "projectName"> = {}
): { registry: WorkspaceRegistry; project: WorkspaceProject } {
  const projectRoot = resolveProjectRoot(projectPath)
  const tasksFile = "TASKS.md"
  const organizationId = slugify(options.organizationId || options.organizationName || "local") || "local"
  const organizationPath = options.organizationPath ? path.resolve(options.organizationPath) : undefined
  const projectId = uniqueId(
    options.projectId ? slugify(options.projectId) : slugify(options.projectName || path.basename(projectRoot) || "project"),
    registry.projects.map(project => project.id)
  )

  const existingProject = registry.projects.find(project => path.resolve(project.path) === projectRoot)
  const nextProject: WorkspaceProject = {
    id: existingProject?.id || projectId,
    name: options.projectName || existingProject?.name || path.basename(projectRoot) || "Project",
    organizationId,
    path: projectRoot,
    tasksFile,
    icon: inferProjectIcon(projectRoot, existingProject?.id || projectId),
    accent: existingProject?.accent || "#7cde9f"
  }

  const organizations = ensureOrganization(registry.organizations, {
    id: organizationId,
    name: options.organizationName || titleize(organizationId),
    path: organizationPath,
    tasksFile: organizationPath && fs.existsSync(path.join(organizationPath, "TASKS.md")) ? "TASKS.md" : undefined,
    accent: "#5bb5ff"
  })

  const projects = existingProject
    ? registry.projects.map(project => project.id === existingProject.id ? nextProject : project)
    : [...registry.projects, nextProject]

  const nextRegistry: WorkspaceRegistry = {
    schemaVersion: 2,
    activeTargetId: targetId("project", nextProject.id),
    organizations,
    projects
  }

  writeLocalProjectMetadata(projectRoot, nextProject)
  return { registry: nextRegistry, project: nextProject }
}

export function updateWorkspaceTarget(
  registry: WorkspaceRegistry,
  input: UpdateWorkspaceTargetInput
): { registry: WorkspaceRegistry; target: WorkspaceOrganization | WorkspaceProject; targetId: string; type: WorkspaceTargetType } {
  const current = findRegistryTarget(registry, input.targetId)
  if (!current) {
    throw new Error(`Workspace target not found: ${input.targetId}`)
  }

  if (current.type === "organization") {
    const previous = current.target as WorkspaceOrganization
    const nextId = slugify(input.organizationId || previous.id) || previous.id
    if (nextId !== previous.id && registry.organizations.some(organization => organization.id === nextId)) {
      throw new Error(`Organization id already exists: ${nextId}`)
    }

    const nextPath = input.organizationPath ? path.resolve(input.organizationPath) : previous.path
    const nextOrganization: WorkspaceOrganization = {
      ...previous,
      id: nextId,
      name: input.organizationName || previous.name || titleize(nextId),
      path: nextPath,
      tasksFile: nextPath && fs.existsSync(path.join(nextPath, "TASKS.md")) ? "TASKS.md" : previous.tasksFile
    }
    const nextProjects = registry.projects.map(project => project.organizationId === previous.id
      ? { ...project, organizationId: nextId }
      : project)
    for (const project of nextProjects) {
      const previousProject = registry.projects.find(item => item.id === project.id)
      if (previousProject?.organizationId === previous.id && fs.existsSync(project.path)) {
        writeLocalProjectMetadata(path.resolve(project.path), project)
      }
    }

    const nextTargetId = targetId("organization", nextId)
    const nextRegistry: WorkspaceRegistry = {
      schemaVersion: 2,
      activeTargetId: registry.activeTargetId === input.targetId ? nextTargetId : registry.activeTargetId,
      organizations: registry.organizations.map(organization => organization.id === previous.id ? nextOrganization : organization),
      projects: nextProjects
    }
    return { registry: nextRegistry, target: nextOrganization, targetId: nextTargetId, type: "organization" }
  }

  const previous = current.target as WorkspaceProject
  const nextId = slugify(input.projectId || previous.id) || previous.id
  if (nextId !== previous.id && registry.projects.some(project => project.id === nextId)) {
    throw new Error(`Project id already exists: ${nextId}`)
  }

  const projectRoot = input.projectPath ? resolveProjectRoot(input.projectPath) : path.resolve(previous.path)
  const organizationId = slugify(input.organizationId || previous.organizationId || "local") || "local"
  const previousOrganization = registry.organizations.find(organization => organization.id === organizationId)
  const organizationPath = input.organizationPath ? path.resolve(input.organizationPath) : previousOrganization?.path
  const organizations = ensureOrganization(registry.organizations, {
    id: organizationId,
    name: input.organizationName || previousOrganization?.name || titleize(organizationId),
    path: organizationPath,
    tasksFile: organizationPath && fs.existsSync(path.join(organizationPath, "TASKS.md")) ? "TASKS.md" : previousOrganization?.tasksFile,
    accent: "#5bb5ff"
  })
  const nextProject: WorkspaceProject = {
    ...previous,
    id: nextId,
    name: input.projectName || previous.name || path.basename(projectRoot) || "Project",
    organizationId,
    path: projectRoot,
    tasksFile: previous.tasksFile || "TASKS.md",
    icon: previous.icon || inferProjectIcon(projectRoot, nextId)
  }
  const nextTargetId = targetId("project", nextId)
  const nextRegistry: WorkspaceRegistry = {
    schemaVersion: 2,
    activeTargetId: registry.activeTargetId === input.targetId ? nextTargetId : registry.activeTargetId,
    organizations,
    projects: registry.projects.map(project => project.id === previous.id ? nextProject : project)
  }

  writeLocalProjectMetadata(projectRoot, nextProject)
  return { registry: nextRegistry, target: nextProject, targetId: nextTargetId, type: "project" }
}

export function findTasksRoot(startPath: string): string | undefined {
  let current = path.resolve(startPath)
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current)
  }

  while (true) {
    if (fs.existsSync(path.join(current, "TASKS.md"))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function resolveWorkspaceTargetTasksFile(target: WorkspaceOrganization | WorkspaceProject): string {
  return path.resolve(target.path || process.cwd(), target.tasksFile || "TASKS.md")
}

function parseOrganizations(value: unknown): WorkspaceOrganization[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((organization): organization is Record<string, unknown> => Boolean(organization) && typeof organization === "object")
    .filter(organization => typeof organization.id === "string")
    .map(organization => ({
      id: String(organization.id),
      name: typeof organization.name === "string" ? organization.name : String(organization.id),
      path: typeof organization.path === "string" ? organization.path : undefined,
      tasksFile: typeof organization.tasksFile === "string" ? organization.tasksFile : undefined,
      icon: typeof organization.icon === "string" ? organization.icon : undefined,
      accent: typeof organization.accent === "string" ? organization.accent : undefined
    }))
}

function parseProjects(value: unknown): WorkspaceProject[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((project): project is Record<string, unknown> => Boolean(project) && typeof project === "object")
    .filter(project => typeof project.id === "string" && typeof project.path === "string")
    .map(project => ({
      id: String(project.id),
      name: typeof project.name === "string" ? project.name : String(project.id),
      organizationId: typeof project.organizationId === "string"
        ? project.organizationId
        : typeof project.organization === "string"
          ? project.organization
          : undefined,
      path: path.resolve(String(project.path)),
      tasksFile: typeof project.tasksFile === "string" ? project.tasksFile : undefined,
      icon: typeof project.icon === "string" ? project.icon : undefined,
      accent: typeof project.accent === "string" ? project.accent : undefined
    }))
}

function normalizeActiveTargetId(
  activeTarget: unknown,
  legacyActiveProject: unknown,
  organizations: WorkspaceOrganization[],
  projects: WorkspaceProject[]
): string | undefined {
  const targetIds = new Set([
    ...organizations.map(organization => targetId("organization", organization.id)),
    ...projects.map(project => targetId("project", project.id))
  ])
  if (typeof activeTarget === "string" && targetIds.has(activeTarget)) return activeTarget
  if (typeof legacyActiveProject === "string") {
    if (targetIds.has(legacyActiveProject)) return legacyActiveProject
    const projectTarget = targetId("project", legacyActiveProject)
    if (targetIds.has(projectTarget)) return projectTarget
  }
  if (projects[0]) return targetId("project", projects[0].id)
  if (organizations[0]) return targetId("organization", organizations[0].id)
  return undefined
}

function findRegistryTarget(registry: WorkspaceRegistry, requestedTargetId: string): { type: WorkspaceTargetType; target: WorkspaceOrganization | WorkspaceProject } | undefined {
  const organization = registry.organizations.find(item => targetId("organization", item.id) === requestedTargetId)
  if (organization) return { type: "organization", target: organization }
  const project = registry.projects.find(item => targetId("project", item.id) === requestedTargetId)
  if (project) return { type: "project", target: project }
  return undefined
}

function resolveProjectRoot(projectPath: string): string {
  const resolved = path.resolve(projectPath)
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return path.dirname(resolved)
  }
  const tasksRoot = findTasksRoot(resolved)
  if (!tasksRoot) {
    throw new Error(`No TASKS.md found at or above: ${resolved}`)
  }
  return tasksRoot
}

function ensureOrganization(organizations: WorkspaceOrganization[], organization: WorkspaceOrganization): WorkspaceOrganization[] {
  if (organizations.some(item => item.id === organization.id)) {
    return organizations.map(item => item.id === organization.id
      ? {
          ...item,
          name: organization.name || item.name,
          path: organization.path || item.path,
          tasksFile: organization.tasksFile || item.tasksFile,
          accent: item.accent || organization.accent,
          icon: item.icon || organization.icon
        }
      : item)
  }
  return [...organizations, organization]
}

function inferProjectIcon(projectRoot: string, projectId: string): string | undefined {
  const candidates = [
    path.join(projectRoot, ".mapctx", "projects", projectId, "icon.svg"),
    path.join(projectRoot, ".mapctx", "project.svg"),
    path.join(projectRoot, ".mapctx", "icon.svg")
  ]
  const found = candidates.find(candidate => fs.existsSync(candidate))
  if (!found) return undefined
  return path.relative(projectRoot, found).replace(/\\/g, "/")
}

function writeLocalProjectMetadata(projectRoot: string, project: WorkspaceProject): void {
  const dir = path.join(projectRoot, ".mapctx")
  fs.mkdirSync(dir, { recursive: true })
  const metadataPath = path.join(dir, "project.json")
  const metadata = {
    schemaVersion: 1,
    id: project.id,
    name: project.name,
    organizationId: project.organizationId,
    tasksFile: project.tasksFile || "TASKS.md"
  }
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
}

function uniqueId(base: string, existing: string[]): string {
  const safeBase = base || "project"
  const used = new Set(existing)
  if (!used.has(safeBase)) return safeBase
  for (let index = 2; ; index++) {
    const candidate = `${safeBase}-${index}`
    if (!used.has(candidate)) return candidate
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function titleize(value: string): string {
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || value
}
