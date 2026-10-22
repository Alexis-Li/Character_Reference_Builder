import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import sharp from "sharp";
import { POST as openProject } from "../route";
import { GET as readProject, POST as saveProject } from "../../route";
import { POST as saveImage } from "../../../workflow-images/route";
import { WorkflowBrowserView } from "@/components/quickstart/WorkflowBrowserView";
import { checkWriteTarget } from "@/lib/security/projectWriteScope.server";
import { isRegisteredProjectRoot } from "@/lib/security/projectRoots.server";
import { localApiNextRequest, resetTestLocalSessions, TEST_LOCAL_ORIGIN } from "@/test/localApiRequest";

vi.mock("@/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

let directory: string;
let projectDir: string;
const workflow = { version: 1, id: "migrated", name: "Migrated project", nodes: [], edges: [] };
const post = (route: string, body: unknown) => localApiNextRequest(`${TEST_LOCAL_ORIGIN}${route}`, {
  method: "POST", body: JSON.stringify(body),
});
const read = (target: string) => readProject(localApiNextRequest(
  `${TEST_LOCAL_ORIGIN}/api/workflow?path=${encodeURIComponent(target)}&load=true`));
const open = (target: string) => openProject(post("/api/workflow/open", { directoryPath: target }));

beforeEach(async () => {
  resetTestLocalSessions();
  localStorage.clear();
  const tempRoot = process.env.CRB_TEMP_ROOT ?? path.resolve("../.tmp");
  await fs.mkdir(tempRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(tempRoot, "crb-12-open-"));
  projectDir = path.join(directory, "migrated");
  await fs.mkdir(projectDir);
  await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify(workflow));
  // The project is deliberately outside every default/configured write root.
  const isolatedRoot = path.join(directory, "runtime");
  await fs.mkdir(isolatedRoot);
  vi.stubEnv("CRB_TEMP_ROOT", isolatedRoot);
  vi.stubEnv("CRB_DATA_ROOT", isolatedRoot);
  vi.stubEnv("CRB_PROJECT_ROOTS", "");
  vi.stubEnv("TMPDIR", isolatedRoot);
  vi.stubEnv("TMP", isolatedRoot);
  vi.stubEnv("TEMP", isolatedRoot);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetTestLocalSessions();
  expect(path.basename(directory)).toMatch(/^crb-12-open-/);
  await fs.rm(directory, { recursive: true, force: true });
});

describe("explicit project opening (R-007 / R-008)", () => {
  it("opens from the form, then saves workflow and media outside preauthorized roots", async () => {
    expect(checkWriteTarget(projectDir)).toMatchObject({ ok: false, reason: "outside-authorized-root" });
    expect((await (await read(projectDir)).json()).workflow).toEqual(workflow);
    expect(isRegisteredProjectRoot(projectDir)).toBe(false);
    const body = { directoryPath: projectDir, filename: "project", workflow };
    expect((await (await saveProject(post("/api/workflow", body))).json()).error).toContain("outside-authorized-root");

    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/workflow/open") return openProject(post(url, JSON.parse(String(init?.body))));
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const loaded = vi.fn(), close = vi.fn();
    render(<WorkflowBrowserView onWorkflowLoaded={loaded} onClose={close} />);
    fireEvent.change(screen.getByLabelText("项目目录路径"), { target: { value: projectDir } });
    fireEvent.click(screen.getByText("按路径打开项目"));
    await waitFor(() => expect(loaded).toHaveBeenCalledWith(workflow, projectDir));
    expect(close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(isRegisteredProjectRoot(projectDir)).toBe(true);

    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
    const mediaResult = await saveImage(post("/api/workflow-images", { workflowPath: projectDir,
      imageId: "new-image", folder: "generations", imageData: `data:image/png;base64,${image.toString("base64")}` }));
    expect((await mediaResult.json()).success).toBe(true);
    expect(await fs.readFile(path.join(projectDir, "generations/new-image.png"))).toEqual(image);
    const updated = { ...workflow, name: "Edited after opening" };
    expect((await (await saveProject(post("/api/workflow", { ...body, workflow: updated }))).json()).success).toBe(true);
    expect((await (await read(projectDir)).json()).workflow.name).toBe(updated.name);
    expect(checkWriteTarget(path.join(directory, "unselected-sibling"))).toMatchObject({ ok: false, reason: "outside-authorized-root" });
  });

  it.each(["missing", "file", "invalid-json"])("retains the form for a %s project using real route responses", async kind => {
    const target = path.join(directory, kind);
    if (kind === "file") await fs.writeFile(target, "{}");
    if (kind === "invalid-json") {
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "broken.json"), "{");
    }
    const readResponse = await read(target);
    expect(readResponse.status).toBeGreaterThanOrEqual(400);
    expect((await readResponse.json()).success).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => open(target)));
    const loaded = vi.fn(), close = vi.fn();
    render(<WorkflowBrowserView onWorkflowLoaded={loaded} onClose={close} />);
    fireEvent.change(screen.getByLabelText("项目目录路径"), { target: { value: target } });
    fireEvent.click(screen.getByText("按路径打开项目"));
    expect(await screen.findByRole("alert")).not.toBeEmptyDOMElement();
    expect(screen.getByLabelText("项目目录路径")).toHaveValue(target);
    expect(screen.getByText("按路径打开项目")).toBeEnabled();
    expect(loaded).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(isRegisteredProjectRoot(target)).toBe(false);
  });

  it("does not register a root without the local session capability", async () => {
    const request = localApiNextRequest(`${TEST_LOCAL_ORIGIN}/api/workflow/open`, {
      method: "POST", body: JSON.stringify({ directoryPath: projectDir }), omitSession: true,
    });
    expect((await openProject(request)).status).toBe(401);
    expect(isRegisteredProjectRoot(projectDir)).toBe(false);
  });

  it.each(["src", "public", ".next"])("does not authorize the application's %s subtree", async subtree => {
    const target = path.resolve(subtree);
    const response = await open(target);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("denied-subtree");
    expect(isRegisteredProjectRoot(target)).toBe(false);
  });

  it("rejects a junction/symlink without authorizing the linked project", async () => {
    const link = path.join(directory, "linked-project");
    await fs.symlink(projectDir, link, process.platform === "win32" ? "junction" : "dir");
    const response = await open(link);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("linked-path");
    expect(isRegisteredProjectRoot(link)).toBe(false);
    expect(isRegisteredProjectRoot(projectDir)).toBe(false);
  });

  it.each([{}, { directoryPath: 123 }, { directoryPath: "relative/path" },
    { directoryPath: `${process.cwd()}/../outside` }])("rejects invalid open input %j", async body => {
    expect((await openProject(post("/api/workflow/open", body))).status).toBe(400);
    expect(isRegisteredProjectRoot(projectDir)).toBe(false);
  });

  it("keeps recoverable previous JSON loading compatible", async () => {
    await fs.rename(path.join(projectDir, "project.json"), path.join(projectDir, "project.json.previous"));
    await fs.writeFile(path.join(projectDir, "project.json"), "{");
    const response = await open(projectDir);
    expect(response.status).toBe(200);
    expect((await response.json()).workflow).toEqual(workflow);
  });
});
