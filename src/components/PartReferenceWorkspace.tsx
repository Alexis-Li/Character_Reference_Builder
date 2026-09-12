"use client";

import { useEffect, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useLoadGenerationById } from "@/hooks/useLoadGenerationById";
import {
  approveCandidate,
  definePart,
  newCharacterId,
  selectCandidate,
  selectionKey,
  setPartRequirement,
  type CharacterProject,
} from "@/lib/characterProject";
import {
  PART_REFERENCE_PRESET,
  partReferencePrompt,
} from "@/lib/partReference";
import type { ImageInputNodeData, NanoBananaNodeData } from "@/types";

function saveProject(project: CharacterProject) {
  useWorkflowStore.setState({
    characterProject: project,
    hasUnsavedChanges: true,
  });
  useWorkflowStore.getState().syncSessionProtection();
}

export function PartReferenceWorkspace() {
  const project = useWorkflowStore((s) => s.characterProject);
  const nodes = useWorkflowStore((s) => s.nodes);
  const busy = useWorkflowStore((s) => s.isRunning);
  const [open, setOpen] = useState(false);
  const [partId, setPartId] = useState("");
  const [name, setName] = useState("");
  const [requirements, setRequirements] = useState("");
  const [locks, setLocks] = useState("");
  const [view, setView] = useState("正面");
  const [parent, setParent] = useState("");
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [images, setImages] = useState<Record<string, string>>({});
  const load = useLoadGenerationById("image", "Image");
  const part = project?.parts.find((p) => p.id === partId);
  const candidates =
    project?.candidates.filter((c) => c.partId === partId) ?? [];
  const originals = nodes.filter(
    (n) =>
      n.type === "imageInput" &&
      !n.data.partReferenceCopy &&
      (n.data as ImageInputNodeData).image,
  );

  useEffect(() => {
    let active = true;
    Promise.all(
      (project?.candidates ?? []).map(
        async (c) => [c.id, await load(c.id)] as const,
      ),
    ).then((rows) => {
      if (active)
        setImages(
          Object.fromEntries(
            rows.filter((r): r is readonly [string, string] => !!r[1]),
          ),
        );
    });
    return () => {
      active = false;
    };
  }, [project, load]);

  function choosePart(id: string) {
    const selected = project?.parts.find((p) => p.id === id);
    setPartId(id);
    setName(selected?.name ?? "");
    setRequirements(selected?.requirements.join("\n") ?? "");
    setParent("");
    setInstruction("");
  }

  function confirm() {
    if (!name.trim()) {
      setError("请写明部件、左右及归属，确认目标后再生成。");
      return;
    }
    let next = useWorkflowStore.getState().ensureCharacterProject();
    const id = partId || newCharacterId("part");
    if (!partId)
      next = definePart(next, {
        id,
        name: name.trim(),
        requirements: [],
        correctionHistory: [],
      });
    next = {
      ...next,
      parts: next.parts.map((p) =>
        p.id === id ? { ...p, name: name.trim() } : p,
      ),
    };
    next = setPartRequirement(
      next,
      id,
      requirements.split("\n").filter(Boolean),
      `确认目标：${name.trim()}；${requirements}`,
    );
    saveProject(next);
    setPartId(id);
    setError("");
  }

  async function generate() {
    setError("");
    setWorking(true);
    try {
      const state = useWorkflowStore.getState();
      const current = state.characterProject;
      if (
        !current ||
        !part ||
        name.trim() !== part.name ||
        requirements !== part.requirements.join("\n")
      )
        throw new Error("请先确认或更正目标与有效要求。");
      if (!originals.length) throw new Error("请先导入原画资料。");
      if (state.isRunning) throw new Error("请等待当前运行结束。");
      const base = parent
        ? current.candidates.find(
            (c) => c.id === parent && c.partId === partId && c.view === view,
          )
        : undefined;
      if (parent && !base)
        throw new Error("优化输入必须属于当前部件及指定视图。");
      const retained = Object.values(current.selection)
        .map((id) => current.candidates.find((c) => c.id === id))
        .filter((c) => c && c.partId === partId && c.view !== view);
      const refs: {
        image: string;
        role: "target" | "retained-view";
        label: string;
      }[] = [];
      for (const c of [...(base ? [base] : []), ...retained]) {
        if (!c) continue;
        const image = await load(c.id);
        if (!image)
          throw new Error(`候选 ${c.id} 的图片缺失，请恢复文件后再生成。`);
        refs.push({
          image,
          role: c === base ? "target" : "retained-view",
          label: `${c.view} · ${c.id}`,
        });
      }
      const parentTask = state.nodes.find((n) =>
        (n.data as NanoBananaNodeData).imageHistory?.some(
          (h) => h.id === base?.id,
        ),
      )?.data as NanoBananaNodeData | undefined;
      const instructions = [
        ...(parentTask?.partTask?.instructions ?? []),
        instruction,
      ].filter(Boolean);
      const nodeId = state.addNode(
        "nanoBanana",
        { x: 500, y: nodes.length * 40 },
        {
          customTitle: base ? "参考优化" : "部件参考生成",
          inputPrompt: partReferencePrompt(
            current,
            partId,
            view,
            instructions.join("\n"),
          ),
          partTask: {
            partId,
            view,
            inputCandidateId: base?.id,
            instructions,
            inferenceNotes: "遮挡或无原画依据的补全均为推测，待人工确认。",
          },
        },
      );
      for (const original of originals)
        state.onConnect(
          {
            source: original.id,
            target: nodeId,
            sourceHandle: "image",
            targetHandle: "image",
          },
          { referenceRole: "auxiliary" },
        );
      for (const ref of refs) {
        const source = state.addNode(
          "imageInput",
          { x: 100, y: nodes.length * 40 },
          {
            image: ref.image,
            filename: ref.label,
            partReferenceCopy: true,
            customTitle: ref.label,
          },
        );
        state.onConnect(
          {
            source,
            target: nodeId,
            sourceHandle: "image",
            targetHandle: "image",
          },
          { referenceRole: ref.role },
        );
      }
      await useWorkflowStore.getState().regenerateNode(nodeId);
      const data = useWorkflowStore
        .getState()
        .nodes.find((n) => n.id === nodeId)?.data as NanoBananaNodeData;
      if (data?.error) setError(data.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <button
        className="px-4 py-2 text-left border-b border-neutral-700"
        onClick={() => {
          useWorkflowStore.getState().setShowQuickstart(false);
          setOpen(!open);
          setLocks(
            project?.projectLocks.map((l) => l.description).join("\n") ?? "",
          );
        }}
      >
        单部件参考工作区 {open ? "收起" : "打开"}
      </button>
      {open && (
        <section
          aria-label="单部件参考工作区"
          className="overflow-auto max-h-[75vh] p-4 bg-neutral-900 text-neutral-100 space-y-3 [&_input]:bg-neutral-800 [&_input]:border [&_input]:border-neutral-600 [&_input]:p-2 [&_textarea]:bg-neutral-800 [&_textarea]:border [&_textarea]:border-neutral-600 [&_textarea]:p-2 [&_select]:bg-neutral-800 [&_select]:p-2 [&_button]:rounded [&_button]:border [&_button]:border-neutral-600 [&_button]:px-3 [&_button]:py-2 [&_button:disabled]:opacity-40 [&_label]:flex [&_label]:flex-col [&_label]:gap-1"
        >
          <div className="flex gap-4 items-center">
            <h2 className="font-bold">
              原画 → 确认目标 → 生成／优化 → 比较与选择
            </h2>
            <button
              onClick={() => {
                setRequirements(PART_REFERENCE_PRESET.locks);
                setView("正面");
              }}
            >
              加载默认单部件预设
            </button>
          </div>
          <p>
            默认无需 SAM 或
            Mask。加载预设不会生成图片。请确认部件归属、左右和遮挡；不确定处可更正后再确认。
          </p>
          <label>
            导入原画资料{" "}
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={working || busy}
              onChange={async (e) => {
                for (const file of Array.from(e.target.files ?? [])) {
                  if (!file.type.startsWith("image/")) continue;
                  const reader = new FileReader();
                  reader.onload = () =>
                    useWorkflowStore
                      .getState()
                      .addNode(
                        "imageInput",
                        { x: 0, y: 0 },
                        {
                          image: String(reader.result),
                          filename: file.name,
                          customTitle: "原画依据",
                        },
                      );
                  reader.readAsDataURL(file);
                }
              }}
            />
          </label>
          <div className="flex gap-2">
            {originals.map((n) => (
              <img
                key={n.id}
                src={(n.data as ImageInputNodeData).image!}
                alt={(n.data as ImageInputNodeData).filename ?? "原画"}
                className="h-24 object-contain"
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <label>
              建模部件{" "}
              <select
                value={partId}
                onChange={(e) => choosePart(e.target.value)}
              >
                <option value="">新建部件</option>
                {project?.parts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              目标说明{" "}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：角色左侧腰带扣，排除手部"
              />
            </label>
            <label>
              部件有效要求{" "}
              <textarea
                value={requirements}
                onChange={(e) => setRequirements(e.target.value)}
              />
            </label>
            <button onClick={confirm} disabled={working || busy}>
              确认／更正目标
            </button>
            <label>
              共同设计锁定{" "}
              <textarea
                value={locks}
                onChange={(e) => setLocks(e.target.value)}
              />
            </label>
            <button
              disabled={working || busy}
              onClick={() =>
                useWorkflowStore.getState().updateCharacterLocks(
                  locks
                    .split("\n")
                    .filter(Boolean)
                    .map((description, i) => ({
                      id: `lock-${i}`,
                      description,
                    })),
                )
              }
            >
              保存共同锁定
            </button>
          </div>
          <p>
            当前有效要求：{part?.requirements.join("；") || "未确认"}
            ；共同锁定：
            {project?.projectLocks.map((l) => l.description).join("；") ||
              "未设置"}
          </p>
          <div className="flex flex-wrap gap-3 items-center">
            <label>
              只修改视图{" "}
              <select
                value={view}
                onChange={(e) => {
                  setView(e.target.value);
                  setParent("");
                }}
              >
                {PART_REFERENCE_PRESET.views.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              优化输入{" "}
              <select
                value={parent}
                onChange={(e) => setParent(e.target.value)}
              >
                <option value="">从原画生成</option>
                {candidates
                  .filter((c) => c.view === view)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} · {c.review}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              本轮修改要求{" "}
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
            <button disabled={!part || busy || working} onClick={generate}>
              {working
                ? "处理中…"
                : parent
                  ? "从此候选生成优化分支"
                  : "生成候选"}
            </button>
          </div>
          <p>
            其他视图的人工选定结果自动作为一致性参考，原文件保持不变。长期要求请写入“部件有效要求”。未批准候选也可优化。
          </p>
          {error && (
            <p role="alert" className="text-red-400">
              {error} 已有结果仍可比较、选择和导出；再次生成由你手动发起。
            </p>
          )}
          <div className="flex gap-4 overflow-x-auto" aria-label="候选并排比较">
            {candidates.map((c) => (
              <article
                key={c.id}
                className="min-w-64 max-w-80 border border-neutral-600 p-2 space-y-2"
              >
                {images[c.id] ? (
                  <a href={images[c.id]} target="_blank" rel="noreferrer">
                    <img
                      src={images[c.id]}
                      alt={`${c.view} ${c.id}`}
                      className="h-56 w-full object-contain"
                    />
                  </a>
                ) : (
                  <p>图片加载中或文件缺失</p>
                )}
                <p className="break-all">
                  {c.view} · {c.id}
                </p>
                <p>
                  {project?.selection[selectionKey(partId, c.view)] === c.id
                    ? "已选中"
                    : "未选中"}{" "}
                  ·{" "}
                  {c.review === "approved"
                    ? "已批准"
                    : c.review === "stale"
                      ? "依据已变更，待复核"
                      : "未批准"}
                </p>
                <p className="break-all">
                  来源：{c.parentCandidateId ?? "原画生成"}
                </p>
                <p>{c.inferenceNotes}</p>
                <button
                  onClick={() =>
                    saveProject(
                      selectCandidate(
                        useWorkflowStore.getState().characterProject!,
                        partId,
                        c.view,
                        c.id,
                      ),
                    )
                  }
                >
                  选中
                </button>{" "}
                <button
                  onClick={() =>
                    saveProject(
                      approveCandidate(
                        useWorkflowStore.getState().characterProject!,
                        c.id,
                      ),
                    )
                  }
                >
                  批准
                </button>{" "}
                <button
                  onClick={() => {
                    setParent(c.id);
                    setView(c.view);
                  }}
                >
                  从此继续／分支
                </button>{" "}
                {images[c.id] && (
                  <a
                    href={images[c.id]}
                    download={`${part?.name}-${c.view}-${c.id}.png`}
                  >
                    导出此版本
                  </a>
                )}
              </article>
            ))}
          </div>
          <details>
            <summary>当前部件更正历史</summary>
            {part?.correctionHistory.map((h, i) => (
              <p key={i}>{h.note}</p>
            ))}
          </details>
        </section>
      )}
    </>
  );
}
