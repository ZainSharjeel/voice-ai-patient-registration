import { useAuthActions } from "@convex-dev/auth/react";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { useState } from "react";
import { controlStyles } from "@/components/controlStyles";
import { cn } from "@/lib/utils";
import { Button, Card, Input, Label } from "@/ui";

type Step =
  | "signIn"
  | { type: "forgot"; email?: string }
  | { type: "reset-code"; email: string }
  | { type: "new-password"; email: string; code: string };

export function SignIn() {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<Step>("signIn");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (step === "signIn") {
    return (
      <Card className="rounded-xl border bg-card text-card-foreground p-6 shadow-md">
        <form
          onSubmit={async e => {
            e.preventDefault();
            setError("");
            setLoading(true);

            const formData = new FormData(e.currentTarget);
            try {
              await signIn("password", formData);
            } catch {
              setError("Invalid email or password");
            } finally {
              setLoading(false);
            }
          }}
          className="space-y-4"
        >
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
            <div className="flex items-center justify-between">
              <Label
                className="text-sm font-medium leading-none"
                htmlFor="password"
              >
                Password
              </Label>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
                onClick={() => setStep({ type: "forgot" })}
              >
                Forgot password?
              </button>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              className={cn(controlStyles.input, "h-11")}
              required
            />
          </div>
          <input name="flow" value="signIn" type="hidden" />
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
            {loading ? "Signing in..." : "Sign In"}
          </Button>
        </form>
      </Card>
    );
  }

  if (step.type === "forgot") {
    return (
      <Card className="rounded-xl border bg-card text-card-foreground p-6 shadow-md">
        <div className="text-center mb-6">
          <h2 className="font-semibold text-lg">Reset Password</h2>
          <p className="text-sm text-muted-foreground">
            Enter your email to receive a reset code
          </p>
        </div>
        <form
          onSubmit={async e => {
            e.preventDefault();
            setError("");
            setLoading(true);

            const formData = new FormData(e.currentTarget);
            const email = formData.get("email") as string;
            try {
              await signIn("password", formData);
              setStep({ type: "reset-code", email });
            } catch {
              setError("Could not send reset code. Please try again.");
            } finally {
              setLoading(false);
            }
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label className="text-sm font-medium leading-none" htmlFor="email">
              Email
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              defaultValue={step.email}
              autoComplete="email"
              className={cn(controlStyles.input, "h-11")}
              required
            />
          </div>
          <input name="flow" value="reset" type="hidden" />
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
            {loading ? "Sending..." : "Send Reset Code"}
          </Button>
          <Button
            className={cn(controlStyles.quietButton, "w-full")}
            onClick={() => setStep("signIn")}
          >
            <ArrowLeft className="size-4" />
            Back to sign in
          </Button>
        </form>
      </Card>
    );
  }

  if (step.type === "reset-code") {
    return (
      <Card className="rounded-xl border bg-card text-card-foreground p-6 shadow-md">
        <div className="text-center mb-6">
          <div className="mx-auto size-12 rounded-full bg-primary flex items-center justify-center mb-4">
            <Mail className="size-6 text-primary-foreground" />
          </div>
          <h2 className="font-semibold text-lg">Check your email</h2>
          <p className="text-sm text-muted-foreground">
            We sent a code to {step.email}
          </p>
        </div>
        <form
          onSubmit={e => {
            e.preventDefault();
            setError("");
            const formData = new FormData(e.currentTarget);
            const code = formData.get("code") as string;
            setStep({ type: "new-password", email: step.email, code });
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label className="text-sm font-medium leading-none" htmlFor="code">
              Reset Code
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
          >
            Continue
          </Button>
          <Button
            className={cn(controlStyles.quietButton, "w-full")}
            onClick={() => setStep({ type: "forgot", email: step.email })}
          >
            Resend code
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border bg-card text-card-foreground p-6 shadow-md">
      <div className="text-center mb-6">
        <h2 className="font-semibold text-lg">Set New Password</h2>
        <p className="text-sm text-muted-foreground">
          Choose a strong password
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
            setError("Could not reset password. Code may be expired.");
            setStep({ type: "forgot", email: step.email });
          } finally {
            setLoading(false);
          }
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label
            className="text-sm font-medium leading-none"
            htmlFor="newPassword"
          >
            New Password
          </Label>
          <Input
            id="newPassword"
            name="newPassword"
            type="password"
            placeholder="••••••••"
            minLength={6}
            autoComplete="new-password"
            className={cn(controlStyles.input, "h-11")}
            required
          />
        </div>
        <input name="flow" value="reset-verification" type="hidden" />
        <input name="email" value={step.email} type="hidden" />
        <input name="code" value={step.code} type="hidden" />
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
          {loading ? "Resetting..." : "Reset Password"}
        </Button>
        <Button
          className={cn(controlStyles.quietButton, "w-full")}
          onClick={() => setStep("signIn")}
        >
          <ArrowLeft className="size-4" />
          Cancel
        </Button>
      </form>
    </Card>
  );
}
