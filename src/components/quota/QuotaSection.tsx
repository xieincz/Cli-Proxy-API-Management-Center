/**
 * Generic quota section component.
 */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { useLocalStorage } from '@/hooks';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { QuotaCard } from './QuotaCard';
import type { QuotaStatusState } from './QuotaCard';
import { useQuotaLoader } from './useQuotaLoader';
import type { QuotaConfig } from './quotaConfigs';
import { useGridColumns } from './useGridColumns';
import { IconRefreshCw } from '@/components/ui/icons';
import styles from '@/pages/QuotaPage.module.scss';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

type ViewMode = 'paged' | 'all';

const MAX_ITEMS_PER_PAGE = 25;
const MAX_SHOW_ALL_THRESHOLD = 30;
const DEFAULT_CODEX_REFRESH_TIMEOUT_SECONDS = 30;
const MIN_CODEX_REFRESH_TIMEOUT_SECONDS = 5;
const MAX_CODEX_REFRESH_TIMEOUT_SECONDS = 600;
const CODEX_BATCH_REFRESH_CONCURRENCY = 10;

interface BatchRefreshProgress {
  completed: number;
  total: number;
}

const clampCodexRefreshTimeoutSeconds = (value: number): number =>
  Math.min(MAX_CODEX_REFRESH_TIMEOUT_SECONDS, Math.max(MIN_CODEX_REFRESH_TIMEOUT_SECONDS, Math.round(value)));

const normalizeCodexRefreshTimeoutSeconds = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CODEX_REFRESH_TIMEOUT_SECONDS;
  }
  return clampCodexRefreshTimeoutSeconds(parsed);
};

interface QuotaPaginationState<T> {
  pageSize: number;
  totalPages: number;
  currentPage: number;
  pageItems: T[];
  setPageSize: (size: number) => void;
  goToPrev: () => void;
  goToNext: () => void;
  loading: boolean;
  loadingScope: 'page' | 'all' | null;
  setLoading: (loading: boolean, scope?: 'page' | 'all' | null) => void;
}

const useQuotaPagination = <T,>(items: T[], defaultPageSize = 6): QuotaPaginationState<T> => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);
  const [loading, setLoadingState] = useState(false);
  const [loadingScope, setLoadingScope] = useState<'page' | 'all' | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(items.length / pageSize)),
    [items.length, pageSize]
  );

  const currentPage = useMemo(() => Math.min(page, totalPages), [page, totalPages]);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, currentPage, pageSize]);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
  }, []);

  const goToPrev = useCallback(() => {
    setPage((prev) => Math.max(1, prev - 1));
  }, []);

  const goToNext = useCallback(() => {
    setPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  const setLoading = useCallback((isLoading: boolean, scope?: 'page' | 'all' | null) => {
    setLoadingState(isLoading);
    setLoadingScope(isLoading ? (scope ?? null) : null);
  }, []);

  return {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading,
    loadingScope,
    setLoading
  };
};

interface QuotaSectionProps<TState extends QuotaStatusState, TData> {
  config: QuotaConfig<TState, TData>;
  files: AuthFileItem[];
  loading: boolean;
  disabled: boolean;
}

export function QuotaSection<TState extends QuotaStatusState, TData>({
  config,
  files,
  loading,
  disabled
}: QuotaSectionProps<TState, TData>) {
  const { t } = useTranslation();
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;
  const isCodexSection = config.type === 'codex';

  const [columns, gridRef] = useGridColumns(380); // Min card width 380px matches SCSS
  const [viewMode, setViewMode] = useState<ViewMode>('paged');
  const [showTooManyWarning, setShowTooManyWarning] = useState(false);
  const [codexRefreshTimeoutSeconds, setCodexRefreshTimeoutSeconds] = useLocalStorage<number>(
    'quota.codexRefreshTimeoutSeconds',
    DEFAULT_CODEX_REFRESH_TIMEOUT_SECONDS
  );
  const normalizedCodexRefreshTimeoutSeconds = normalizeCodexRefreshTimeoutSeconds(
    codexRefreshTimeoutSeconds
  );
  const [codexRefreshTimeoutInput, setCodexRefreshTimeoutInput] = useState(() =>
    String(normalizedCodexRefreshTimeoutSeconds)
  );
  const [codexRefreshProgress, setCodexRefreshProgress] = useState<BatchRefreshProgress | null>(
    null
  );

  const filteredFiles = useMemo(() => files.filter((file) => config.filterFn(file)), [
    files,
    config
  ]);
  const showAllAllowed = filteredFiles.length <= MAX_SHOW_ALL_THRESHOLD;
  const effectiveViewMode: ViewMode = viewMode === 'all' && !showAllAllowed ? 'paged' : viewMode;

  const {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading: sectionLoading,
    loadingScope,
    setLoading
  } = useQuotaPagination(filteredFiles);

  useEffect(() => {
    if (showAllAllowed) return;
    if (viewMode !== 'all') return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setViewMode('paged');
      setShowTooManyWarning(true);
    });

    return () => {
      cancelled = true;
    };
  }, [showAllAllowed, viewMode]);

  // Update page size based on view mode and columns
  useEffect(() => {
    if (effectiveViewMode === 'all') {
      setPageSize(Math.max(1, filteredFiles.length));
    } else {
      // Paged mode: 3 rows * columns, capped to avoid oversized pages.
      setPageSize(Math.min(columns * 3, MAX_ITEMS_PER_PAGE));
    }
  }, [effectiveViewMode, columns, filteredFiles.length, setPageSize]);

  const { quota, loadQuota } = useQuotaLoader(config);

  const pendingQuotaRefreshRef = useRef(false);
  const prevFilesLoadingRef = useRef(loading);
  const isRefreshing = sectionLoading || loading;
  const isRefreshingAll = sectionLoading && loadingScope === 'all';

  useEffect(() => {
    if (codexRefreshTimeoutSeconds !== normalizedCodexRefreshTimeoutSeconds) {
      setCodexRefreshTimeoutSeconds(normalizedCodexRefreshTimeoutSeconds);
      return;
    }

    setCodexRefreshTimeoutInput(String(normalizedCodexRefreshTimeoutSeconds));
  }, [
    codexRefreshTimeoutSeconds,
    normalizedCodexRefreshTimeoutSeconds,
    setCodexRefreshTimeoutSeconds
  ]);

  const handleRefresh = useCallback(() => {
    pendingQuotaRefreshRef.current = true;
    void triggerHeaderRefresh();
  }, []);

  const commitCodexRefreshTimeoutInput = useCallback(
    (rawValue: string) => {
      const trimmed = rawValue.trim();
      if (!trimmed) {
        setCodexRefreshTimeoutInput(String(normalizedCodexRefreshTimeoutSeconds));
        return;
      }

      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        setCodexRefreshTimeoutInput(String(normalizedCodexRefreshTimeoutSeconds));
        return;
      }

      const nextValue = clampCodexRefreshTimeoutSeconds(parsed);
      setCodexRefreshTimeoutSeconds(nextValue);
      setCodexRefreshTimeoutInput(String(nextValue));
    },
    [normalizedCodexRefreshTimeoutSeconds, setCodexRefreshTimeoutSeconds]
  );

  const handleRefreshAll = useCallback(() => {
    if (!isCodexSection || filteredFiles.length === 0 || isRefreshing) return;

    startTransition(() => {
      setCodexRefreshProgress({
        completed: 0,
        total: filteredFiles.length
      });
    });

    void loadQuota(filteredFiles, {
      scope: 'all',
      setLoading,
      concurrency: CODEX_BATCH_REFRESH_CONCURRENCY,
      fetchOptions: {
        timeoutMs: normalizedCodexRefreshTimeoutSeconds * 1000
      },
      onProgress: ({ completed, total }) => {
        startTransition(() => {
          setCodexRefreshProgress({ completed, total });
        });
      }
    }).finally(() => {
      startTransition(() => {
        setCodexRefreshProgress(null);
      });
    });
  }, [
    filteredFiles,
    isCodexSection,
    isRefreshing,
    loadQuota,
    normalizedCodexRefreshTimeoutSeconds,
    setLoading
  ]);

  useEffect(() => {
    const wasLoading = prevFilesLoadingRef.current;
    prevFilesLoadingRef.current = loading;

    if (!pendingQuotaRefreshRef.current) return;
    if (loading) return;
    if (!wasLoading) return;

    pendingQuotaRefreshRef.current = false;
    const scope = effectiveViewMode === 'all' ? 'all' : 'page';
    const targets = effectiveViewMode === 'all' ? filteredFiles : pageItems;
    if (targets.length === 0) return;
    void loadQuota(targets, { scope, setLoading });
  }, [loading, effectiveViewMode, filteredFiles, pageItems, loadQuota, setLoading]);

  useEffect(() => {
    if (loading) return;
    if (filteredFiles.length === 0) {
      setQuota({});
      return;
    }
    setQuota((prev) => {
      const nextState: Record<string, TState> = {};
      filteredFiles.forEach((file) => {
        const cached = prev[file.name];
        if (cached) {
          nextState[file.name] = cached;
        }
      });
      return nextState;
    });
  }, [filteredFiles, loading, setQuota]);

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t(`${config.i18nPrefix}.title`)}</span>
      {filteredFiles.length > 0 && (
        <span className={styles.countBadge}>
          {filteredFiles.length}
        </span>
      )}
    </div>
  );

  const codexRefreshProgressLabel = codexRefreshProgress
    ? t('quota_management.codex_refresh_progress', {
        current: codexRefreshProgress.completed,
        total: codexRefreshProgress.total
      })
    : null;

  return (
    <Card
      title={titleNode}
      extra={
        <div className={styles.headerActions}>
          <div className={styles.viewModeToggle}>
            <Button
              variant={effectiveViewMode === 'paged' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setViewMode('paged')}
            >
              {t('auth_files.view_mode_paged')}
            </Button>
            <Button
              variant={effectiveViewMode === 'all' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                if (filteredFiles.length > MAX_SHOW_ALL_THRESHOLD) {
                  setShowTooManyWarning(true);
                } else {
                  setViewMode('all');
                }
              }}
            >
              {t('auth_files.view_mode_all')}
            </Button>
          </div>
          {isCodexSection && (
            <div className={styles.codexBatchControls}>
              <div className={styles.headerControl}>
                <label htmlFor="codex-refresh-timeout">
                  {t('quota_management.codex_refresh_timeout')}
                </label>
                <Input
                  id="codex-refresh-timeout"
                  type="number"
                  min={MIN_CODEX_REFRESH_TIMEOUT_SECONDS}
                  max={MAX_CODEX_REFRESH_TIMEOUT_SECONDS}
                  step={5}
                  inputMode="numeric"
                  className={styles.timeoutInput}
                  value={codexRefreshTimeoutInput}
                  onChange={(event) => setCodexRefreshTimeoutInput(event.currentTarget.value)}
                  onBlur={(event) => commitCodexRefreshTimeoutInput(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitCodexRefreshTimeoutInput(event.currentTarget.value);
                    }
                  }}
                  aria-label={t('quota_management.codex_refresh_timeout')}
                  title={t('quota_management.codex_refresh_timeout')}
                  disabled={disabled || isRefreshing}
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRefreshAll}
                disabled={disabled || isRefreshing || filteredFiles.length === 0}
                loading={isRefreshingAll}
                title={t('quota_management.refresh_codex_all')}
                aria-label={
                  codexRefreshProgressLabel
                    ? `${t('quota_management.refresh_codex_all')} ${codexRefreshProgressLabel}`
                    : t('quota_management.refresh_codex_all')
                }
              >
                {t('quota_management.refresh_codex_all')}
              </Button>
              {isRefreshingAll && codexRefreshProgressLabel && (
                <span className={styles.refreshProgressBadge} aria-live="polite">
                  {codexRefreshProgressLabel}
                </span>
              )}
            </div>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            disabled={disabled || isRefreshing}
            loading={isRefreshing}
            title={t('quota_management.refresh_files_and_quota')}
            aria-label={t('quota_management.refresh_files_and_quota')}
          >
            {!isRefreshing && <IconRefreshCw size={16} />}
          </Button>
        </div>
      }
    >
      {filteredFiles.length === 0 ? (
        <EmptyState
          title={t(`${config.i18nPrefix}.empty_title`)}
          description={t(`${config.i18nPrefix}.empty_desc`)}
        />
      ) : (
        <>
          <div ref={gridRef} className={config.gridClassName}>
            {pageItems.map((item) => (
              <QuotaCard
                key={item.name}
                item={item}
                quota={quota[item.name]}
                resolvedTheme={resolvedTheme}
                i18nPrefix={config.i18nPrefix}
                cardIdleMessageKey={config.cardIdleMessageKey}
                cardClassName={config.cardClassName}
                defaultType={config.type}
                renderQuotaItems={config.renderQuotaItems}
              />
            ))}
          </div>
          {filteredFiles.length > pageSize && effectiveViewMode === 'paged' && (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToPrev}
                disabled={currentPage <= 1}
              >
                {t('auth_files.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('auth_files.pagination_info', {
                  current: currentPage,
                  total: totalPages,
                  count: filteredFiles.length
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToNext}
                disabled={currentPage >= totalPages}
              >
                {t('auth_files.pagination_next')}
              </Button>
            </div>
          )}
        </>
      )}
      {showTooManyWarning && (
        <div className={styles.warningOverlay} onClick={() => setShowTooManyWarning(false)}>
          <div className={styles.warningModal} onClick={(e) => e.stopPropagation()}>
            <p>{t('auth_files.too_many_files_warning')}</p>
            <Button variant="primary" size="sm" onClick={() => setShowTooManyWarning(false)}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
