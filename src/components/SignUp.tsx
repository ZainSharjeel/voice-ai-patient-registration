import { useAuthActions } from "@convex-dev/auth/react";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { useState } from "react";
import { controlStyles } from "@/components/controlStyles";
import { cn } from "@/lib/utils";
import { Button, Card, Input, Label } from "@/ui";

type Step = "signUp" | { email: string };

export function SignUp() {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<Step>("signUp");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (step === "signUp") {
    return (
      <Card className="rounded-xl border bg-card text-card-foreground p-6 shadow-md">
        <form
          onSubmit={async e => {
            e.preventDefault();
            setError("");
            setLoading(true);

            const formData = new FormData(e.currentTarget);
            const email = formData.get("email") as string;
            try {
              await signIn("password", formData);
              setStep({ email });
            } catch {
              setError("Could not create account. Please try again.");
            } finally {
              setLoading(false);
            }
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label className="text-sm font-medium leading-none" htmlFor="name">
              Name
            </Label>
            <Input
              id="name"
              name="name"
              type="text"
              placeholder="Your name"
              autoComplete="name"
              className={cn(controlStyles.input, "h-11")}
              required
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium leading-none" htmlFor="email">
              Email
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              className={cn(controlStyles.input, "h-11")}
              required
            />
          </div>
          <div className="space-y-2">
            <Label
              className="text-sm font-medium leading-none"
              htmlFor="password"
            >
              Password
            </Label>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="••••••••"
              minLength={6}
              autoComplete="new-password"
              className={cn(controlStyles.input, "h-11")}
              required
            />
            <p className="text-xs text-muted-foreground">
              Must be at least 6 characters
            </p>
          </div>
          <input name="flow" value="signUp" type="hidden" />
          {error && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className={cn(
              controlStyles.primaryButton,
              "h-11 px-6 text-base w-full",
            )}
            disabled={loading}
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {loading ? "Creating account..." : "Create Account"}
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border bg-card text-card-foreground p-6 shadow-md">
      <div className="text-center mb-6">
        <div className="mx-auto size-12 rounded-full bg-primary flex items-center justify-center mb-4">
          <Mail className="size-6 text-primary-foreground" />
        </div>
        <h2 className="font-semibold text-lg">Check your email</h2>
        <p className="text-sm text-muted-foreground">
          We sent a verification code to {step.email}
        </p>
      </div>
      <form
        onSubmit={async e => {
          e.preventDefault();
          setError("");
          setLoading(true);

          const formData = new FormData(e.currentTarget);
          try {
            await signIn("password", formData);
          } catch {
            setError("Invalid or expired code. Please try again.");
          } finally {
            setLoading(false);
          }
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label className="text-sm font-medium leading-none" htmlFor="code">
            Verification Code
          </Label>
          <Input
            id="code"
            name="code"
            type="text"
            placeholder="Enter code"
            autoComplete="one-time-code"
            className={cn(
              controlStyles.input,
              "h-11 text-center tracking-[0.5em] font-mono",
            )}
            required
          />
        </div>
        <input name="flow" value="email-verification" type="hidden" />
        <input name="email" value={step.email} type="hidden" />
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className={cn(
            controlStyles.primaryButton,
            "h-11 px-6 text-base w-full",
          )}
          disabled={loading}
        >
          {loading && <Loader2 className="size-4 animate-spin" />}
          {loading ? "Verifying..." : "Verify Email"}
        </Button>
        <Button
          className={cn(controlStyles.quietButton, "w-full")}
          onClick={() => setStep("signUp")}
        >
          <ArrowLeft className="size-4" />
          Back to sign up
        </Button>
      </form>
    </Card>
  );
}
