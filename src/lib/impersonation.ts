import { createContext, useContext } from "react";
import type { UserProfile } from "@/app/pages/AuthPage";

export interface ImpersonationState {
  impersonating: UserProfile | null;
  realProfile: UserProfile | null;
  setImpersonating: (p: UserProfile | null) => void;
}

export const ImpersonationCtx = createContext<ImpersonationState>({
  impersonating: null,
  realProfile: null,
  setImpersonating: () => {},
});

export function useImpersonation() {
  return useContext(ImpersonationCtx);
}
