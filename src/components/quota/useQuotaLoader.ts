/**
 * Generic hook for quota data fetching and management.
 */

import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { useQuotaStore } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import type { QuotaConfig, QuotaFetchOptions } from './quotaConfigs';

type QuotaScope = 'page' | 'all';
const DEFAULT_ALL_SCOPE_CONCURRENCY = 10;

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

interface LoadQuotaResult<TData> {
  name: string;
  status: 'success' | 'error';
  data?: TData;
  error?: string;
  errorStatus?: number;
}

interface LoadQuotaOptions {
  scope: QuotaScope;
  setLoading: (loading: boolean, scope?: QuotaScope | null) => void;
  fetchOptions?: QuotaFetchOptions;
  concurrency?: number;
  onProgress?: (progress: { completed: number; total: number }) => void;
}

export function useQuotaLoader<TState, TData>(config: QuotaConfig<TState, TData>) {
  const { t } = useTranslation();
  const quota = useQuotaStore(config.storeSelector);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;

  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (targets: AuthFileItem[], options: LoadQuotaOptions) => {
      const { scope, setLoading, fetchOptions, concurrency, onProgress } = options;
      if (loadingRef.current) return;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      setLoading(true, scope);

      try {
        if (targets.length === 0) return;

        setQuota((prev) => {
          const nextState = { ...prev };
          targets.forEach((file) => {
            nextState[file.name] = config.buildLoadingState();
          });
          return nextState;
        });

        const total = targets.length;
        let completed = 0;
        let nextIndex = 0;

        const workerCount = Math.max(
          1,
          Math.min(
            total,
            concurrency ?? (scope === 'all' ? DEFAULT_ALL_SCOPE_CONCURRENCY : total)
          )
        );

        const applyResult = (result: LoadQuotaResult<TData>) => {
          if (requestId !== requestIdRef.current) return;

          setQuota((prev) => {
            const nextState = { ...prev };
            if (result.status === 'success') {
              nextState[result.name] = config.buildSuccessState(result.data as TData);
            } else {
              nextState[result.name] = config.buildErrorState(
                result.error || t('common.unknown_error'),
                result.errorStatus
              );
            }
            return nextState;
          });

          completed += 1;
          onProgress?.({ completed, total });
        };

        const loadSingleQuota = async (file: AuthFileItem): Promise<LoadQuotaResult<TData>> => {
          try {
            const data = await config.fetchQuota(file, t, fetchOptions);
            return { name: file.name, status: 'success', data };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : t('common.unknown_error');
            const errorStatus = getStatusFromError(err);
            return { name: file.name, status: 'error', error: message, errorStatus };
          }
        };

        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (true) {
              const currentIndex = nextIndex;
              nextIndex += 1;
              if (currentIndex >= total) return;

              const file = targets[currentIndex];
              const result = await loadSingleQuota(file);
              applyResult(result);
            }
          })
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [config, setQuota, t]
  );

  return { quota, loadQuota };
}
