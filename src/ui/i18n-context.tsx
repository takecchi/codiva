import { createContext, useContext } from 'react';
import { type Messages, messages } from '@/core';

/**
 * 表示言語のカタログを配る React コンテキスト。App が解決済みの Messages を Provider で流し、
 * 各コンポーネントは `useMessages()` で購読する（props バケツリレーを避ける）。
 * Provider 外（コンポーネント単体テスト等）では既定の ja カタログにフォールバックする。
 */
const MessagesContext = createContext<Messages>(messages.ja);

export const MessagesProvider = MessagesContext.Provider;

export function useMessages(): Messages {
  return useContext(MessagesContext);
}
