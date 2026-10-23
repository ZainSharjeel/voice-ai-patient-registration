import { useAuthActions } from "@convex-dev/auth/react";
import { Loader2, Zap } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import {
  markViktorSignInAttempt,
  oauthCallbackUrl,
  rememberOAuthReturn,
  VIKTOR_SIGN_IN_FAILED_VALUE,
  VIKTOR_SIGN_IN_PARAM,
} from "@/auth/oauthReturn";
import { controlStyles } from "@/components/controlStyles";
import { cn } from "@/lib/utils";
import {
  getEmailPasswordSignInAvailable,
  getViktorSignInAvailable,
} from "@/lib/viktor-spaces-access/config";
import { Button, Separator } from "@/ui";

/**
 * "Sign in with Viktor" — one-click sign-in for members of the Viktor
 * workspace that owns this app. First click runs the OAuth round trip and
 * creates the account automatically; afterwards the stored Convex Auth
 * session keeps the user signed in.
 *
 * The round trip lands on the dedicated callback route, which resolves the
 * outcome and comes back here with an explicit failure param when the
 * attempt was denied — this component never infers failure from transient
 * auth state, so no error can flash during a successful sign-in.
 */
export function ViktorSignInSection() {
  const { signIn } = useAuthActions();
  const [searchParams] = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const [redirectFailed, setRedirectFailed] = useState(false);

  const available = getViktorSignInAvailable();
  const emailPasswordAvailable = getEmailPasswordSignInAvailable();
  if (!available) {
    return null;
  }

  const attemptFailed =
    redirectFailed ||
    searchParams.get(VIKTOR_SIGN_IN_PARAM) === VIKTOR_SIGN_IN_FAILED_VALUE;

  const handleViktorSignIn = async () => {
    setRedirectFailed(false);
    setRedirecting(true);
    markViktorSignInAttempt();
    rememberOAuthReturn();
    try {
      await signIn("viktor", {
        redirectTo: oauthCallbackUrl(),
      });
    } catch {
      setRedirecting(false);
      setRedirectFailed(true);
    }
  };

  return (
    <>
      <Button
        onClick={handleViktorSignIn}
        disabled={redirecting}
        className={cn(controlStyles.secondaryButton, "w-full h-11")}
      >
        {redirecting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Zap className="size-4" />
        )}
        {redirecting ? "Redirecting..." : "Sign in with Viktor"}
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        One-click sign-in for members of this app's workspace
      </p>
      {attemptFailed && !redirecting && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
          {emailPasswordAvailable
            ? "Viktor sign-in didn't complete. You may not be a member of this app's workspace — sign in with email and password instead."
            : "Viktor sign-in didn't complete. You may not be a member of this app's workspace."}
        </p>
      )}

      {emailPasswordAvailable && (
        <div className="relative py-4">
          <Separator className="h-px w-full bg-border" />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-3 text-xs text-muted-foreground">
            or continue with email
          </span>
        </div>
      )}
    </>
  );
}
