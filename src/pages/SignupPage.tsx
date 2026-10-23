import { Link } from "react-router";
import { SignUp } from "@/components/SignUp";
import { ViktorSignInSection } from "@/components/ViktorSignInSection";
import { getEmailPasswordSignInAvailable } from "@/lib/viktor-spaces-access/config";

export function SignupPage() {
  const emailPasswordAvailable = getEmailPasswordSignInAvailable();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-2xl font-semibold">Create an account</h1>

      <ViktorSignInSection />
      {emailPasswordAvailable && <SignUp />}

      {emailPasswordAvailable && (
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            to="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      )}
    </main>
  );
}
