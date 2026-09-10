"use client";

interface QuickstartInitialViewProps {
  onNewProject: () => void;
  onSelectLoad: () => void;
}

export function QuickstartInitialView({
  onNewProject,
  onSelectLoad,
}: QuickstartInitialViewProps) {
  return (
    <div className="p-8">
      <div className="flex gap-10">
        <div className="flex-1 flex flex-col">
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <img src="/banana_icon.png" alt="" className="w-7 h-7" />
              <h1 className="text-2xl font-medium text-neutral-100">Node Banana</h1>
            </div>
          </div>

          <p className="text-sm text-neutral-400 leading-relaxed mb-6">
            A focused node-based workflow editor for building image reference pipelines. Start with an image, prompt, generation, annotation, comparison and output.
          </p>

          <div className="flex flex-col gap-2.5 mt-auto">
            <a
              href="https://node-banana-docs.vercel.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                />
              </svg>
              Docs
            </a>
          </div>
        </div>

        <div className="flex-1 flex flex-col gap-2 justify-end">
          <OptionButton
            onClick={onNewProject}
            icon={
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4.5v15m7.5-7.5h-15"
              />
            }
            title="New project"
            description="Start a new workflow"
          />

          <OptionButton
            onClick={onSelectLoad}
            icon={
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
              />
            }
            title="Load workflow"
            description="Open existing file"
          />
        </div>
      </div>
    </div>
  );
}

function OptionButton({
  onClick,
  icon,
  title,
  description,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left p-4 rounded-lg border border-neutral-700/50 hover:border-neutral-600 hover:bg-neutral-800/40 transition-all duration-150"
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-md bg-neutral-700/50 flex items-center justify-center flex-shrink-0 group-hover:bg-neutral-700 transition-colors">
          <svg
            className="w-4 h-4 text-neutral-400 group-hover:text-neutral-300 transition-colors"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            {icon}
          </svg>
        </div>
        <div>
          <h3 className="text-sm font-medium text-neutral-200 group-hover:text-neutral-100 transition-colors">
            {title}
          </h3>
          <p className="text-xs text-neutral-500">{description}</p>
        </div>
      </div>
    </button>
  );
}
