import { Link } from "react-router";
import { SignIn } from "@/components/SignIn";
import { ViktorSignInSection } from "@/components/ViktorSignInSection";
import {
  getEmailPasswordSignInAvailable,
  getViktorSignInAvailable,
} from "@/lib/viktor-spaces-access/config";

function getLoginProviderState(): {
  emailPasswordAvailable: boolean;
  viktorSignInAvailable: boolean;
  invalidProviderConfiguration: boolean;
} {
  try {
    return {
      emailPasswordAvailable: getEmailPasswordSignInAvailable(),
      viktorSignInAvailable: getViktorSignInAvailable(),
      invalidProviderConfiguration: false,
    };
  } catch {
    return {
      emailPasswordAvailable: false,
      viktorSignInAvailable: false,
      invalidProviderConfiguration: true,
    };
  }
}

export function LoginPage() {
  const {
    emailPasswordAvailable,
    viktorSignInAvailable,
    invalidProviderConfiguration,
  } = getLoginProviderState();
  const signInUnavailable = !emailPasswordAvailable && !viktorSignInAvailable;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>

      {!invalidProviderConfiguration && <ViktorSignInSection />}
      {emailPasswordAvailable && <SignIn />}
      {signInUnavailable && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2 text-center">
          {invalidProviderConfiguration
            ? "Sign-in is unavailable: this app has no valid sign-in provider configuration. Contact the app owner."
            : 'Sign-in is unavailable: this app only offers "Sign in with Viktor", but its Viktor sign-in configuration is missing from this build. Contact the app owner.'}
        </p>
      )}

      {emailPasswordAvailable && (
        <p className="text-center text-sm text-muted-foreground">
          Don't have an account?{" "}
          <Link
            to="/signup"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign up
          </Link>
        </p>
      )}
    </main>
  );
}
