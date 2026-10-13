"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { getFileUrls } from "@/lib/read-client";
import { FileUrlQueue } from "./file-url-cache";
import { discardNotificationScope } from "./notification-store";
const Scope = createContext("");
let queue: FileUrlQueue | undefined;
function browserQueue() {
  if (typeof window === "undefined")
    throw new Error("File previews require a browser.");
  return (queue ??= new FileUrlQueue(getFileUrls));
}
export const thumbnailUrl = (scope: string, id: string) =>
  browserQueue().get(scope, id);
export const invalidateThumbnail = (scope: string, id: string) =>
  browserQueue().invalidate(scope, id);
export function useReadScope() {
  return useContext(Scope);
}
export function ReadScope({
  scope,
  children,
}: {
  scope: string;
  children: React.ReactNode;
}) {
  const [revokedScope, setRevokedScope] = useState<string>();
  useEffect(() => {
    const reset = () => {
      queue?.reset();
      discardNotificationScope("");
    };
    const revoked = () => {
      reset();
      setRevokedScope(scope);
    };
    window.addEventListener("workspace-access-revoked", revoked);
    return () => {
      reset();
      window.removeEventListener("workspace-access-revoked", revoked);
    };
  }, [scope]);
  return (
    <Scope.Provider value={scope}>
      {revokedScope === scope ? (
        <p role="status">Your access has changed. Redirecting?</p>
      ) : (
        children
      )}
    </Scope.Provider>
  );
}
