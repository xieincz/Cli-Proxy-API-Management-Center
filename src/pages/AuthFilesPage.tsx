import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { animate } from 'motion/mini';
import type { AnimationPlaybackControlsWithThen } from 'motion-dom';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { copyToClipboard } from '@/utils/clipboard';
import { resolveCodexPlanType } from '@/utils/quota';
import {
  MAX_CARD_PAGE_SIZE,
  MIN_CARD_PAGE_SIZE,
  QUOTA_PROVIDER_TYPES,
  clampCardPageSize,
  getAuthFileModifiedTimestamp,
  getAuthFileStatusMessage,
  getTypeColor,
  getTypeLabel,
  hasAuthFileStatusMessage,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  parsePriorityValue,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { AuthFileDetailModal } from '@/features/authFiles/components/AuthFileDetailModal';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFilesPrefixProxyEditorModal } from '@/features/authFiles/components/AuthFilesPrefixProxyEditorModal';
import { OAuthExcludedCard } from '@/features/authFiles/components/OAuthExcludedCard';
import { OAuthModelAliasCard } from '@/features/authFiles/components/OAuthModelAliasCard';
import iconAntigravity from '@/assets/icons/antigravity.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconCodex from '@/assets/icons/codex.svg';
import iconGemini from '@/assets/icons/gemini.svg';
import iconIflow from '@/assets/icons/iflow.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconQwen from '@/assets/icons/qwen.svg';
import iconVertex from '@/assets/icons/vertex.svg';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { useAuthFilesStats } from '@/features/authFiles/hooks/useAuthFilesStats';
import { useAuthFilesStatusBarCache } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import {
  isAuthFilesSortMode,
  readAuthFilesUiState,
  writeAuthFilesUiState,
  type AuthFilesSortMode,
} from '@/features/authFiles/uiState';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import styles from './AuthFilesPage.module.scss';

const easePower3Out = (progress: number) => 1 - (1 - progress) ** 4;
const easePower2In = (progress: number) => progress ** 3;
const BATCH_BAR_BASE_TRANSFORM = 'translateX(-50%)';
const BATCH_BAR_HIDDEN_TRANSFORM = 'translateX(-50%) translateY(56px)';
const AUTH_FILE_FILTER_ICONS: Record<string, string | { light: string; dark: string }> = {
  antigravity: iconAntigravity,
  aistudio: iconGemini,
  claude: iconClaude,
  codex: iconCodex,
  gemini: iconGemini,
  'gemini-cli': iconGemini,
  iflow: iconIflow,
  kimi: { light: iconKimiLight, dark: iconKimiDark },
  qwen: iconQwen,
  vertex: iconVertex,
};

const getFilterTagIcon = (type: string, resolvedTheme: ResolvedTheme): string | null => {
  const iconEntry = AUTH_FILE_FILTER_ICONS[normalizeProviderKey(type)];
  if (!iconEntry) return null;
  return typeof iconEntry === 'string'
    ? iconEntry
    : resolvedTheme === 'dark'
      ? iconEntry.dark
      : iconEntry.light;
};

const matchesAuthFileSearch = (item: AuthFileItem, search: string): boolean => {
  const term = search.trim().toLowerCase();
  if (!term) return true;

  const statusMessage = getAuthFileStatusMessage(item).toLowerCase();
  return (
    item.name.toLowerCase().includes(term) ||
    (item.type || '').toString().toLowerCase().includes(term) ||
    (item.provider || '').toString().toLowerCase().includes(term) ||
    statusMessage.includes(term)
  );
};

const matchesAuthFileFilter = (
  item: AuthFileItem,
  filter: string,
  search: string,
  problemOnly: boolean
): boolean => {
  if (filter !== 'all' && item.type !== filter) return false;
  if (problemOnly && !hasAuthFileStatusMessage(item)) return false;
  return matchesAuthFileSearch(item, search);
};

export function AuthFilesPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const navigate = useNavigate();

  const [filter, setFilter] = useState<'all' | string>('all');
  const [problemOnly, setProblemOnly] = useState(false);
  const [hideDisabled, setHideDisabled] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(9);
  const [pageSizeInput, setPageSizeInput] = useState('9');
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<AuthFileItem | null>(null);
  const [viewMode, setViewMode] = useState<'diagram' | 'list'>('list');
  const [sortMode, setSortMode] = useState<AuthFilesSortMode>('default');
  const [batchActionBarVisible, setBatchActionBarVisible] = useState(false);
  const floatingBatchActionsRef = useRef<HTMLDivElement>(null);
  const batchActionAnimationRef = useRef<AnimationPlaybackControlsWithThen | null>(null);
  const previousSelectionCountRef = useRef(0);
  const selectionCountRef = useRef(0);

  const { keyStats, usageDetails, loadKeyStats, refreshKeyStats } = useAuthFilesStats();
  const {
    files,
    selectedFiles,
    loading,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    deselectAll,
    batchSetStatus,
    batchDelete,
  } = useAuthFilesData({ refreshKeyStats });

  const statusBarCache = useAuthFilesStatusBarCache(files, usageDetails);

  const {
    excluded,
    excludedError,
    modelAlias,
    modelAliasError,
    allProviderModels,
    loadExcluded,
    loadModelAlias,
    deleteExcluded,
    deleteModelAlias,
    handleMappingUpdate,
    handleDeleteLink,
    handleToggleFork,
    handleRenameAlias,
    handleDeleteAlias,
  } = useAuthFilesOauth({ viewMode, files });

  const {
    modelsModalOpen,
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    showModels,
    closeModelsModal,
  } = useAuthFilesModels();

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave,
  } = useAuthFilesPrefixProxyEditor({
    disableControls: connectionStatus !== 'connected',
    loadFiles,
    loadKeyStats: refreshKeyStats,
  });

  const disableControls = connectionStatus !== 'connected';
  const normalizedFilter = normalizeProviderKey(String(filter));
  const quotaFilterType: QuotaProviderType | null = QUOTA_PROVIDER_TYPES.has(
    normalizedFilter as QuotaProviderType
  )
    ? (normalizedFilter as QuotaProviderType)
    : null;

  useEffect(() => {
    const persisted = readAuthFilesUiState();
    if (!persisted) return;

    if (typeof persisted.filter === 'string' && persisted.filter.trim()) {
      setFilter(persisted.filter);
    }
    if (typeof persisted.problemOnly === 'boolean') {
      setProblemOnly(persisted.problemOnly);
    }
    if (typeof persisted.hideDisabled === 'boolean') {
      setHideDisabled(persisted.hideDisabled);
    }
    if (typeof persisted.search === 'string') {
      setSearch(persisted.search);
    }
    if (typeof persisted.page === 'number' && Number.isFinite(persisted.page)) {
      setPage(Math.max(1, Math.round(persisted.page)));
    }
    if (typeof persisted.pageSize === 'number' && Number.isFinite(persisted.pageSize)) {
      setPageSize(clampCardPageSize(persisted.pageSize));
    }
    if (isAuthFilesSortMode(persisted.sortMode)) {
      setSortMode(persisted.sortMode);
    }
  }, []);

  useEffect(() => {
    writeAuthFilesUiState({ filter, problemOnly, hideDisabled, search, page, pageSize, sortMode });
  }, [filter, problemOnly, hideDisabled, search, page, pageSize, sortMode]);

  useEffect(() => {
    setPageSizeInput(String(pageSize));
  }, [pageSize]);

  const commitPageSizeInput = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const next = clampCardPageSize(value);
    setPageSize(next);
    setPageSizeInput(String(next));
    setPage(1);
  };

  const handlePageSizeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const rawValue = event.currentTarget.value;
    setPageSizeInput(rawValue);

    const trimmed = rawValue.trim();
    if (!trimmed) return;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;

    const rounded = Math.round(parsed);
    if (rounded < MIN_CARD_PAGE_SIZE || rounded > MAX_CARD_PAGE_SIZE) return;

    setPageSize(rounded);
    setPage(1);
  };

  const handleSortModeChange = useCallback(
    (value: string) => {
      if (!isAuthFilesSortMode(value) || value === sortMode) return;
      setSortMode(value);
      setPage(1);
      void loadFiles().catch(() => {});
    },
    [loadFiles, sortMode]
  );

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadFiles(), refreshKeyStats(), loadExcluded(), loadModelAlias()]);
  }, [loadFiles, refreshKeyStats, loadExcluded, loadModelAlias]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    if (!isCurrentLayer) return;
    loadFiles();
    void loadKeyStats().catch(() => {});
    loadExcluded();
    loadModelAlias();
  }, [isCurrentLayer, loadFiles, loadKeyStats, loadExcluded, loadModelAlias]);

  useInterval(
    () => {
      void refreshKeyStats().catch(() => {});
    },
    isCurrentLayer ? 240_000 : null
  );

  const displayFiles = useMemo(
    () => (hideDisabled ? files.filter((file) => !file.disabled) : files),
    [files, hideDisabled]
  );

  const existingTypes = useMemo(() => {
    const types = new Set<string>(['all']);
    if (filter !== 'all') {
      types.add(filter);
    }
    displayFiles.forEach((file) => {
      if (file.type) {
        types.add(file.type);
      }
    });
    return Array.from(types);
  }, [displayFiles, filter]);

  const filesMatchingProblemFilter = useMemo(
    () => (problemOnly ? displayFiles.filter(hasAuthFileStatusMessage) : displayFiles),
    [displayFiles, problemOnly]
  );

  const sortOptions = useMemo(
    () => [
      { value: 'default', label: t('auth_files.sort_default') },
      { value: 'modified', label: t('auth_files.sort_modified') },
      { value: 'az', label: t('auth_files.sort_az') },
      { value: 'priority', label: t('auth_files.sort_priority') },
    ],
    [t]
  );

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: filesMatchingProblemFilter.length };
    filesMatchingProblemFilter.forEach((file) => {
      if (!file.type) return;
      counts[file.type] = (counts[file.type] || 0) + 1;
    });
    return counts;
  }, [filesMatchingProblemFilter]);

  const enabledTypeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    filesMatchingProblemFilter.forEach((file) => {
      if (file.disabled) return;
      counts.all += 1;
      if (!file.type) return;
      counts[file.type] = (counts[file.type] || 0) + 1;
    });
    return counts;
  }, [filesMatchingProblemFilter]);

  const enabledFilesCount = useMemo(
    () => displayFiles.reduce((count, file) => count + (file.disabled ? 0 : 1), 0),
    [displayFiles]
  );

  const filtered = useMemo(() => {
    return filesMatchingProblemFilter.filter((item) =>
      matchesAuthFileFilter(item, filter, search, false)
    );
  }, [filesMatchingProblemFilter, filter, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sortMode === 'default') {
      copy.sort((a, b) => {
        const providerA = normalizeProviderKey(String(a.provider ?? a.type ?? 'unknown'));
        const providerB = normalizeProviderKey(String(b.provider ?? b.type ?? 'unknown'));
        const providerCompare = providerA.localeCompare(providerB);
        if (providerCompare !== 0) return providerCompare;
        return a.name.localeCompare(b.name);
      });
    } else if (sortMode === 'modified') {
      copy.sort((a, b) => {
        const modifiedA = getAuthFileModifiedTimestamp(a) ?? 0;
        const modifiedB = getAuthFileModifiedTimestamp(b) ?? 0;
        if (modifiedA !== modifiedB) return modifiedB - modifiedA;
        return a.name.localeCompare(b.name);
      });
    } else if (sortMode === 'az') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === 'priority') {
      copy.sort((a, b) => {
        const pa = parsePriorityValue(a.priority ?? a['priority']) ?? 0;
        const pb = parsePriorityValue(b.priority ?? b['priority']) ?? 0;
        return pb - pa; // 高优先级排前面
      });
    }
    return copy;
  }, [filtered, sortMode]);

  const selectableSearchResults = useMemo(
    () => sorted.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [sorted]
  );

  const codexFree401Targets = useMemo(() => {
    const targets: string[] = [];
    const statusPattern = /(^|\D)401(\D|$)/;

    files.forEach((file) => {
      if (isRuntimeOnlyAuthFile(file)) return;
      const providerKey = normalizeProviderKey(String(file.provider ?? file.type ?? ''));
      if (providerKey !== 'codex') return;
      const planType =
        resolveCodexPlanType(file) ??
        (typeof codexQuota[file.name]?.planType === 'string'
          ? codexQuota[file.name]?.planType
          : null);
      if (!planType || planType.trim().toLowerCase() !== 'free') return;
      const statusMessage = getAuthFileStatusMessage(file);
      const hasStatus401 = statusPattern.test(statusMessage);
      const hasQuota401 = codexQuota[file.name]?.errorStatus === 401;
      if (hasStatus401 || hasQuota401) {
        targets.push(file.name);
      }
    });

    return targets;
  }, [codexQuota, files]);

  const codexWeeklyZeroTargets = useMemo(() => {
    const targets: string[] = [];

    files.forEach((file) => {
      if (isRuntimeOnlyAuthFile(file)) return;
      if (file.disabled) return;
      const providerKey = normalizeProviderKey(String(file.provider ?? file.type ?? ''));
      if (providerKey !== 'codex') return;
      const quota = codexQuota[file.name];
      if (!quota || quota.status !== 'success') return;
      const weeklyWindow = (quota.windows ?? []).find((window) => window.id === 'weekly');
      if (!weeklyWindow || typeof weeklyWindow.usedPercent !== 'number') return;
      const clampedUsed = Math.max(0, Math.min(100, weeklyWindow.usedPercent));
      const remaining = Math.max(0, Math.min(100, 100 - clampedUsed));
      if (remaining <= 0) {
        targets.push(file.name);
      }
    });

    return targets;
  }, [codexQuota, files]);

  const codexDisabledWeeklyPositiveTargets = useMemo(() => {
    const targets: string[] = [];

    files.forEach((file) => {
      if (isRuntimeOnlyAuthFile(file)) return;
      if (!file.disabled) return;
      const providerKey = normalizeProviderKey(String(file.provider ?? file.type ?? ''));
      if (providerKey !== 'codex') return;
      const quota = codexQuota[file.name];
      if (!quota || quota.status !== 'success') return;
      const weeklyWindow = (quota.windows ?? []).find((window) => window.id === 'weekly');
      if (!weeklyWindow || typeof weeklyWindow.usedPercent !== 'number') return;
      const clampedUsed = Math.max(0, Math.min(100, weeklyWindow.usedPercent));
      const remaining = Math.max(0, Math.min(100, 100 - clampedUsed));
      if (remaining > 0) {
        targets.push(file.name);
      }
    });

    return targets;
  }, [codexQuota, files]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = sorted.slice(start, start + pageSize);
  const selectablePageItems = useMemo(
    () => pageItems.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [pageItems]
  );
  const selectedNames = useMemo(() => Array.from(selectedFiles), [selectedFiles]);
  const disabledSelectedNames = useMemo(
    () => new Set(files.filter((file) => file.disabled).map((file) => file.name)),
    [files]
  );
  const actionableSelectedNames = useMemo(
    () =>
      hideDisabled
        ? selectedNames.filter((name) => !disabledSelectedNames.has(name))
        : selectedNames,
    [disabledSelectedNames, hideDisabled, selectedNames]
  );
  const selectionCount = actionableSelectedNames.length;
  const hasHiddenDisabledMatches = useMemo(
    () =>
      hideDisabled &&
      files.some((file) => file.disabled && matchesAuthFileFilter(file, filter, search, problemOnly)),
    [files, filter, hideDisabled, problemOnly, search]
  );

  const showDetails = (file: AuthFileItem) => {
    setSelectedFile(file);
    setDetailModalOpen(true);
  };

  const copyTextWithNotification = useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showNotification(
        copied
          ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
          : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  const handleSelectSearchResults = useCallback(() => {
    if (selectableSearchResults.length === 0) {
      showNotification(t('auth_files.search_select_empty'), 'info');
      return;
    }
    selectAllVisible(selectableSearchResults);
  }, [selectAllVisible, selectableSearchResults, showNotification, t]);

  const handleQuickDeleteCodex401 = useCallback(() => {
    if (codexFree401Targets.length === 0) {
      showNotification(t('auth_files.quick_delete_codex_401_empty'), 'info');
      return;
    }
    batchDelete(codexFree401Targets);
  }, [batchDelete, codexFree401Targets, showNotification, t]);

  const handleQuickDisableCodexWeeklyZero = useCallback(() => {
    if (codexWeeklyZeroTargets.length === 0) {
      showNotification(t('auth_files.quick_disable_codex_weekly_zero_empty'), 'info');
      return;
    }
    void batchSetStatus(codexWeeklyZeroTargets, false);
  }, [batchSetStatus, codexWeeklyZeroTargets, showNotification, t]);

  const handleQuickEnableCodexWeeklyPositive = useCallback(() => {
    if (codexDisabledWeeklyPositiveTargets.length === 0) {
      showNotification(t('auth_files.quick_enable_codex_weekly_positive_empty'), 'info');
      return;
    }
    void batchSetStatus(codexDisabledWeeklyPositiveTargets, true);
  }, [batchSetStatus, codexDisabledWeeklyPositiveTargets, showNotification, t]);

  const openExcludedEditor = useCallback(
    (provider?: string) => {
      const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
      const params = new URLSearchParams();
      if (providerValue) {
        params.set('provider', providerValue);
      }
      const nextSearch = params.toString();
      navigate(`/auth-files/oauth-excluded${nextSearch ? `?${nextSearch}` : ''}`, {
        state: { fromAuthFiles: true },
      });
    },
    [filter, navigate]
  );

  const openModelAliasEditor = useCallback(
    (provider?: string) => {
      const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
      const params = new URLSearchParams();
      if (providerValue) {
        params.set('provider', providerValue);
      }
      const nextSearch = params.toString();
      navigate(`/auth-files/oauth-model-alias${nextSearch ? `?${nextSearch}` : ''}`, {
        state: { fromAuthFiles: true },
      });
    },
    [filter, navigate]
  );

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;

    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) {
      document.documentElement.style.removeProperty('--auth-files-action-bar-height');
      return;
    }

    const updatePadding = () => {
      const height = actionsEl.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--auth-files-action-bar-height', `${height}px`);
    };

    updatePadding();
    window.addEventListener('resize', updatePadding);

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePadding);
    ro?.observe(actionsEl);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updatePadding);
      document.documentElement.style.removeProperty('--auth-files-action-bar-height');
    };
  }, [batchActionBarVisible, selectionCount]);

  useEffect(() => {
    selectionCountRef.current = selectionCount;
    if (selectionCount > 0) {
      setBatchActionBarVisible(true);
    }
  }, [selectionCount]);

  useLayoutEffect(() => {
    if (!batchActionBarVisible) return;
    const currentCount = selectionCount;
    const previousCount = previousSelectionCountRef.current;
    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) return;

    batchActionAnimationRef.current?.stop();
    batchActionAnimationRef.current = null;

    if (currentCount > 0 && previousCount === 0) {
      batchActionAnimationRef.current = animate(
        actionsEl,
        {
          transform: [BATCH_BAR_HIDDEN_TRANSFORM, BATCH_BAR_BASE_TRANSFORM],
          opacity: [0, 1],
        },
        {
          duration: 0.28,
          ease: easePower3Out,
          onComplete: () => {
            actionsEl.style.transform = BATCH_BAR_BASE_TRANSFORM;
            actionsEl.style.opacity = '1';
          },
        }
      );
    } else if (currentCount === 0 && previousCount > 0) {
      batchActionAnimationRef.current = animate(
        actionsEl,
        {
          transform: [BATCH_BAR_BASE_TRANSFORM, BATCH_BAR_HIDDEN_TRANSFORM],
          opacity: [1, 0],
        },
        {
          duration: 0.22,
          ease: easePower2In,
          onComplete: () => {
            if (selectionCountRef.current === 0) {
              setBatchActionBarVisible(false);
            }
          },
        }
      );
    }

    previousSelectionCountRef.current = currentCount;
  }, [batchActionBarVisible, selectionCount]);

  useEffect(
    () => () => {
      batchActionAnimationRef.current?.stop();
      batchActionAnimationRef.current = null;
    },
    []
  );

  const renderFilterTags = () => (
    <div className={styles.filterTags}>
      {existingTypes.map((type) => {
        const isActive = filter === type;
        const iconSrc = getFilterTagIcon(type, resolvedTheme);
        const totalCount = typeCounts[type] ?? 0;
        const enabledCount = enabledTypeCounts[type] ?? 0;
        const color =
          type === 'all'
            ? { bg: 'var(--bg-tertiary)', text: 'var(--text-primary)' }
            : getTypeColor(type, resolvedTheme);
        const activeTextColor = resolvedTheme === 'dark' ? '#111827' : '#fff';
        return (
          <button
            key={type}
            className={`${styles.filterTag} ${isActive ? styles.filterTagActive : ''}`}
            style={{
              backgroundColor: isActive ? color.text : color.bg,
              color: isActive ? activeTextColor : color.text,
              borderColor: color.text,
            }}
            onClick={() => {
              setFilter(type);
              setPage(1);
            }}
          >
            <span className={styles.filterTagLabel}>
              {iconSrc && <img src={iconSrc} alt="" className={styles.filterTagIcon} />}
              <span>{getTypeLabel(t, type)}</span>
            </span>
            <span className={styles.filterTagCount}>
              {t('auth_files.count_with_enabled', { total: totalCount, enabled: enabledCount })}
            </span>
          </button>
        );
      })}
    </div>
  );

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t('auth_files.title_section')}</span>
      {files.length > 0 && (
        <span className={styles.countBadge}>
          {t('auth_files.count_with_enabled', {
            total: displayFiles.length,
            enabled: enabledFilesCount,
          })}
        </span>
      )}
    </div>
  );

  const deleteAllButtonLabel = problemOnly
    ? filter === 'all'
      ? t('auth_files.delete_problem_button')
      : t('auth_files.delete_problem_button_with_type', { type: getTypeLabel(t, filter) })
    : filter === 'all'
      ? t('auth_files.delete_all_button')
      : `${t('common.delete')} ${getTypeLabel(t, filter)}`;

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('auth_files.title')}</h1>
        <p className={styles.description}>{t('auth_files.description')}</p>
      </div>

      <Card
        title={titleNode}
        extra={
          <div className={styles.headerActions}>
            <Button variant="secondary" size="sm" onClick={handleHeaderRefresh} disabled={loading}>
              {t('common.refresh')}
            </Button>
            <Button
              size="sm"
              onClick={handleUploadClick}
              disabled={disableControls || uploading}
              loading={uploading}
            >
              {t('auth_files.upload_button')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() =>
                handleDeleteAll({
                  filter,
                  problemOnly,
                  onResetFilterToAll: () => setFilter('all'),
                  onResetProblemOnly: () => setProblemOnly(false),
                })
              }
              disabled={disableControls || loading || deletingAll}
              loading={deletingAll}
            >
              {deleteAllButtonLabel}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        }
      >
        {error && <div className={styles.errorBox}>{error}</div>}

        <div className={styles.filterSection}>
          {renderFilterTags()}

          <div className={styles.filterControls}>
            <div className={styles.filterItem}>
              <label>{t('auth_files.search_label')}</label>
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={t('auth_files.search_placeholder')}
              />
            </div>
            <div className={styles.filterItem}>
              <label>{t('auth_files.page_size_label')}</label>
              <input
                className={styles.pageSizeSelect}
                type="number"
                min={MIN_CARD_PAGE_SIZE}
                max={MAX_CARD_PAGE_SIZE}
                step={1}
                value={pageSizeInput}
                onChange={handlePageSizeChange}
                onBlur={(e) => commitPageSizeInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
            <div className={styles.filterItem}>
              <label>{t('auth_files.sort_label')}</label>
              <Select
                className={styles.sortSelect}
                value={sortMode}
                options={sortOptions}
                onChange={handleSortModeChange}
                ariaLabel={t('auth_files.sort_label')}
                fullWidth={false}
              />
            </div>
            <div className={`${styles.filterItem} ${styles.filterToggleItem}`}>
              <label>{t('auth_files.problem_filter_label')}</label>
              <div className={styles.filterToggle}>
                <ToggleSwitch
                  checked={problemOnly}
                  onChange={(value) => {
                    setProblemOnly(value);
                    setPage(1);
                  }}
                  ariaLabel={t('auth_files.problem_filter_only')}
                  label={
                    <span className={styles.filterToggleLabel}>
                      {t('auth_files.problem_filter_only')}
                    </span>
                  }
                />
              </div>
            </div>
            <div className={`${styles.filterItem} ${styles.filterToggleItem}`}>
              <label>{t('auth_files.disabled_filter_label')}</label>
              <div className={styles.filterToggle}>
                <ToggleSwitch
                  checked={hideDisabled}
                  onChange={(value) => {
                    setHideDisabled(value);
                    setPage(1);
                  }}
                  ariaLabel={t('auth_files.hide_disabled_only')}
                  label={
                    <span className={styles.filterToggleLabel}>
                      {t('auth_files.hide_disabled_only')}
                    </span>
                  }
                />
              </div>
            </div>
            <div className={`${styles.filterItem} ${styles.filterActionsItem}`}>
              <label>{t('auth_files.quick_actions_label')}</label>
              <div className={styles.filterActionButtons}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSelectSearchResults}
                  disabled={selectableSearchResults.length === 0}
                >
                  {t('auth_files.select_search_results', {
                    count: selectableSearchResults.length,
                  })}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleQuickDeleteCodex401}
                  disabled={disableControls || codexFree401Targets.length === 0}
                >
                  {t('auth_files.quick_delete_codex_401', { count: codexFree401Targets.length })}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleQuickDisableCodexWeeklyZero}
                  disabled={disableControls || codexWeeklyZeroTargets.length === 0}
                >
                  {t('auth_files.quick_disable_codex_weekly_zero', {
                    count: codexWeeklyZeroTargets.length,
                  })}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleQuickEnableCodexWeeklyPositive}
                  disabled={disableControls || codexDisabledWeeklyPositiveTargets.length === 0}
                >
                  {t('auth_files.quick_enable_codex_weekly_positive', {
                    count: codexDisabledWeeklyPositiveTargets.length,
                  })}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.hint}>{t('common.loading')}</div>
        ) : pageItems.length === 0 ? (
          <EmptyState
            title={
              files.length === 0
                ? t('auth_files.empty_title')
                : hasHiddenDisabledMatches
                  ? t('auth_files.hidden_disabled_empty_title')
                  : t('auth_files.search_empty_title')
            }
            description={
              files.length === 0
                ? t('auth_files.empty_desc')
                : hasHiddenDisabledMatches
                  ? t('auth_files.hidden_disabled_empty_desc')
                  : t('auth_files.search_empty_desc')
            }
          />
        ) : (
          <div
            className={`${styles.fileGrid} ${quotaFilterType ? styles.fileGridQuotaManaged : ''}`}
          >
            {pageItems.map((file) => (
              <AuthFileCard
                key={file.name}
                file={file}
                selected={selectedFiles.has(file.name)}
                resolvedTheme={resolvedTheme}
                disableControls={disableControls}
                deleting={deleting}
                statusUpdating={statusUpdating}
                quotaFilterType={quotaFilterType}
                keyStats={keyStats}
                statusBarCache={statusBarCache}
                onShowModels={showModels}
                onShowDetails={showDetails}
                onDownload={handleDownload}
                onOpenPrefixProxyEditor={openPrefixProxyEditor}
                onDelete={handleDelete}
                onToggleStatus={handleStatusToggle}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        )}

        {!loading && sorted.length > pageSize && (
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              {t('auth_files.pagination_prev')}
            </Button>
            <div className={styles.pageInfo}>
              {t('auth_files.pagination_info', {
                current: currentPage,
                total: totalPages,
                count: sorted.length,
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
            >
              {t('auth_files.pagination_next')}
            </Button>
          </div>
        )}
      </Card>

      <OAuthExcludedCard
        disableControls={disableControls}
        excludedError={excludedError}
        excluded={excluded}
        onAdd={() => openExcludedEditor()}
        onEdit={openExcludedEditor}
        onDelete={deleteExcluded}
      />

      <OAuthModelAliasCard
        disableControls={disableControls}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onAdd={() => openModelAliasEditor()}
        onEditProvider={openModelAliasEditor}
        onDeleteProvider={deleteModelAlias}
        modelAliasError={modelAliasError}
        modelAlias={modelAlias}
        allProviderModels={allProviderModels}
        onUpdate={handleMappingUpdate}
        onDeleteLink={handleDeleteLink}
        onToggleFork={handleToggleFork}
        onRenameAlias={handleRenameAlias}
        onDeleteAlias={handleDeleteAlias}
      />

      <AuthFileDetailModal
        open={detailModalOpen}
        file={selectedFile}
        onClose={() => setDetailModalOpen(false)}
        onCopyText={copyTextWithNotification}
      />

      <AuthFileModelsModal
        open={modelsModalOpen}
        fileName={modelsFileName}
        fileType={modelsFileType}
        loading={modelsLoading}
        error={modelsError}
        models={modelsList}
        excluded={excluded}
        onClose={closeModelsModal}
        onCopyText={copyTextWithNotification}
      />

      <AuthFilesPrefixProxyEditorModal
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />

      {batchActionBarVisible && typeof document !== 'undefined'
        ? createPortal(
            <div className={styles.batchActionContainer} ref={floatingBatchActionsRef}>
              <div className={styles.batchActionBar}>
                <div className={styles.batchActionLeft}>
                  <span className={styles.batchSelectionText}>
                    {t('auth_files.batch_selected', { count: selectionCount })}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => selectAllVisible(pageItems)}
                    disabled={selectablePageItems.length === 0}
                  >
                    {t('auth_files.batch_select_all')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={deselectAll}>
                    {t('auth_files.batch_deselect')}
                  </Button>
                </div>
                <div className={styles.batchActionRight}>
                  <Button
                    size="sm"
                    onClick={() => batchSetStatus(actionableSelectedNames, true)}
                    disabled={disableControls || actionableSelectedNames.length === 0}
                  >
                    {t('auth_files.batch_enable')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => batchSetStatus(actionableSelectedNames, false)}
                    disabled={disableControls || actionableSelectedNames.length === 0}
                  >
                    {t('auth_files.batch_disable')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => batchDelete(actionableSelectedNames)}
                    disabled={disableControls || actionableSelectedNames.length === 0}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
