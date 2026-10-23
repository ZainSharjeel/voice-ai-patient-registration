import { useAuthActions } from "@convex-dev/auth/react";
import { ConvexHttpClient } from "convex/browser";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { controlStyles } from "@/components/controlStyles";
import { useTheme } from "@/contexts/ThemeContext";
import { getEmailPasswordSignInAvailable } from "@/lib/viktor-spaces-access/config";
import { Button, Input, Label } from "@/ui";
import { api } from "../../convex/_generated/api";

/**
 * `/settings`: the account actions every signed-in app needs, unstyled.
 * Restyle or move them into the app's shell; keep them reachable.
 */
export function SettingsPage() {
  const user = useQuery(api.auth.currentUser);
  const { signOut } = useAuthActions();
  const { theme, toggleTheme } = useTheme();

  return (
    <main className="mx-auto max-w-xl space-y-10 p-4">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Account</h2>
        <p className="text-sm">
          {user?.name ? `${user.name} · ` : ""}
          {user?.email}
        </p>
        <Button
          className={controlStyles.outlineButton}
          onClick={() => void signOut()}
        >
          Sign out
        </Button>
      </section>

      {toggleTheme && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Appearance</h2>
          <Button className={controlStyles.outlineButton} onClick={toggleTheme}>
            {theme === "dark" ? "Use light theme" : "Use dark theme"}
          </Button>
        </section>
      )}

      {getEmailPasswordSignInAvailable() && user?.email && (
        <ChangePassword email={user.email} />
      )}

      <DeleteAccount />
    </main>
  );
}

function ChangePassword({ email }: { email: string }) {
  const { signIn } = useAuthActions();
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const run = async (formData: FormData, flow: string, done: string) => {
    formData.append("email", email);
    formData.append("flow", flow);
    setBusy(true);
    setMessage("");
    try {
      if (flow === "reset") {
        // Convex Auth's client treats the reset request's empty token reply
        // as a sign-out, so the code is requested on a separate client.
        const client = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL);
        await client.action(api.auth.signIn, {
          provider: "password",
          params: Object.fromEntries(formData),
        });
      } else {
        await signIn("password", formData);
      }
      setMessage(done);
      setCodeSent(flow === "reset");
    } catch {
      setMessage(
        flow === "reset"
          ? "Could not send a code. Try again."
          : "Invalid or expired code.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Password</h2>
      {codeSent ? (
        <form
          className="space-y-3"
          onSubmit={e => {
            e.preventDefault();
            void run(
              new FormData(e.currentTarget),
              "reset-verification",
              "Password changed.",
            );
          }}
        >
          <Label htmlFor="code" className="block text-sm font-medium">
            Code from the email
          </Label>
          <Input
            id="code"
            name="code"
            autoComplete="one-time-code"
            className={controlStyles.input}
            required
          />
          <Label htmlFor="newPassword" className="block text-sm font-medium">
            New password
          </Label>
          <Input
            id="newPassword"
            name="newPassword"
            type="password"
            minLength={6}
            autoComplete="new-password"
            className={controlStyles.input}
            required
          />
          <Button
            type="submit"
            className={controlStyles.primaryButton}
            disabled={busy}
          >
            Change password
          </Button>
        </form>
      ) : (
        <Button
          className={controlStyles.outlineButton}
          disabled={busy}
          onClick={() =>
            void run(new FormData(), "reset", `Code sent to ${email}.`)
          }
        >
          Change password
        </Button>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </section>
  );
}

function DeleteAccount() {
  const deleteAccount = useMutation(api.users.deleteAccount);
  const { signOut } = useAuthActions();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    setError("");
    try {
      await deleteAccount();
      // Leave the guarded page first: signing out on it redirects to /login.
      navigate("/");
      await signOut();
    } catch {
      setError("Could not delete the account. Try again.");
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Delete account</h2>
      {confirming ? (
        <>
          <p className="text-sm">
            This permanently deletes your account and signs you out.
          </p>
          <div className="flex gap-2">
            <Button
              className={controlStyles.destructiveButton}
              onClick={() => void confirm()}
            >
              Delete permanently
            </Button>
            <Button
              className={controlStyles.outlineButton}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button
          className={controlStyles.outlineButton}
          onClick={() => setConfirming(true)}
        >
          Delete account
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
