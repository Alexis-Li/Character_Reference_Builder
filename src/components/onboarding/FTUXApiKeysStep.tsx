"use client";

import { useState, useEffect } from "react";
import type { ReactElement } from "react";
import { FTUXStepProps } from "@/types/ftux";
import { ProviderType } from "@/types";
import { EnvStatusResponse } from "@/app/api/env-status/route";
import { useWorkflowStore } from "@/store/workflowStore";
import { MINIMUM_LOOP_FTUX_PROVIDERS } from "@/config/minimumLoop";

// Provider icons
const GeminiIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
  </svg>
);

const FalIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 1855 1855" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M1181.65 78C1212.05 78 1236.42 101.947 1239.32 131.261C1265.25 392.744 1480.07 600.836 1750.02 625.948C1780.28 628.764 1805 652.366 1805 681.816V1174.18C1805 1203.63 1780.28 1227.24 1750.02 1230.05C1480.07 1255.16 1265.25 1463.26 1239.32 1724.74C1236.42 1754.05 1212.05 1778 1181.65 1778H673.354C642.951 1778 618.585 1754.05 615.678 1724.74C589.754 1463.26 374.927 1255.16 104.984 1230.05C74.7212 1227.24 50 1203.63 50 1174.18V681.816C50 652.366 74.7213 628.764 104.984 625.948C374.927 600.836 589.754 392.744 615.678 131.261C618.585 101.946 642.951 78 673.353 78H1181.65ZM402.377 926.561C402.377 1209.41 638.826 1438.71 930.501 1438.71C1222.18 1438.71 1458.63 1209.41 1458.63 926.561C1458.63 643.709 1222.18 414.412 930.501 414.412C638.826 414.412 402.377 643.709 402.377 926.561Z" />
  </svg>
);

interface ProviderInfo {
  id: ProviderType;
  name: string;
  icon: () => ReactElement;
  apiKeyUrl: string;
  isRecommended?: boolean;
}

const allProviders: ProviderInfo[] = [
  { id: "gemini", name: "Google Gemini", icon: GeminiIcon, apiKeyUrl: "https://aistudio.google.com/apikey", isRecommended: true },
  { id: "fal", name: "fal.ai", icon: FalIcon, apiKeyUrl: "https://fal.ai/dashboard/keys", isRecommended: true },
];

const providers: ProviderInfo[] = allProviders.filter((provider) =>
  MINIMUM_LOOP_FTUX_PROVIDERS.has(provider.id)
);

export function FTUXApiKeysStep({}: FTUXStepProps) {
  const updateProviderApiKey = useWorkflowStore((state) => state.updateProviderApiKey);
  const providerSettings = useWorkflowStore((state) => state.providerSettings);
  const [envStatus, setEnvStatus] = useState<EnvStatusResponse | null>(null);
  const [showKey, setShowKey] = useState<Record<ProviderType, boolean>>({
    gemini: false,
    openai: false,
    anthropic: false,
    replicate: false,
    fal: false,
    kie: false,
    wavespeed: false,
  });
  const [localKeys, setLocalKeys] = useState<Record<ProviderType, string>>(() => {
    const keys: Record<ProviderType, string> = {
      gemini: "",
      openai: "",
      anthropic: "",
      replicate: "",
      fal: "",
      kie: "",
      wavespeed: "",
    };
    for (const id of Object.keys(keys) as ProviderType[]) {
      const saved = providerSettings.providers[id]?.apiKey;
      if (saved) keys[id] = saved;
    }
    return keys;
  });

  useEffect(() => {
    fetch("/api/env-status")
      .then((res) => res.json())
      .then((data: EnvStatusResponse) => setEnvStatus(data))
      .catch(() => setEnvStatus(null));
  }, []);

  const hasEnvKey = (providerId: ProviderType): boolean => {
    if (!envStatus) return false;
    return envStatus[providerId] === true;
  };

  const handleKeyChange = (providerId: ProviderType, value: string) => {
    const newValue = value || "";
    setLocalKeys((prev) => ({
      ...prev,
      [providerId]: newValue,
    }));
    // Save to localStorage immediately (null if empty string)
    updateProviderApiKey(providerId, newValue || null);
  };

  return (
    <div className="py-6 px-6">
      <h3 className="text-lg font-semibold text-neutral-100 mb-2">
        API Keys
      </h3>
      <p className="text-sm text-neutral-400 mb-4">
        Add keys for the image reference loop (stored in browser), or save them to your .env file for better security and persistence. Other providers stay in Settings.
      </p>

      <div className="space-y-2">
        {providers.map((provider) => {
          const Icon = provider.icon;
          const hasKey = hasEnvKey(provider.id);

          return (
            <div
              key={provider.id}
              className={`p-3 rounded-lg border ${
                provider.isRecommended
                  ? "bg-green-500/10 border-green-600/30"
                  : "bg-neutral-900 border-neutral-700"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="text-neutral-300 shrink-0">
                    <Icon />
                  </div>
                  <span className="text-sm font-medium text-neutral-100 truncate">
                    {provider.name}
                  </span>
                  <div className="relative group shrink-0">
                    <a
                      href={provider.apiKeyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-neutral-400 hover:text-neutral-200 transition-colors"
                      aria-label={`Get ${provider.name} API key`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </a>
                    <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-2 py-1 bg-neutral-900 text-neutral-200 text-xs rounded border border-neutral-700 whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
                      Get API key
                    </div>
                  </div>
                  {provider.isRecommended && (
                    <span className="text-xs text-green-400 shrink-0">Recommended</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {hasKey ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-green-400">
                        Configured via .env
                      </span>
                      <svg
                        className="w-4 h-4 text-green-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    </div>
                  ) : (
                    <input
                      type={showKey[provider.id] ? "text" : "password"}
                      value={localKeys[provider.id]}
                      onChange={(e) => handleKeyChange(provider.id, e.target.value)}
                      placeholder="Enter key..."
                      className="w-32 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
                    />
                  )}
                  {!hasKey && (
                    <button
                      type="button"
                      onClick={() =>
                        setShowKey((prev) => ({
                          ...prev,
                          [provider.id]: !prev[provider.id],
                        }))
                      }
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      {showKey[provider.id] ? "Hide" : "Show"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
