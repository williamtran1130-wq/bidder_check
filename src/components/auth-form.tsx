"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { ArrowRight, Eye, EyeOff, LoaderCircle, Mail } from "lucide-react";
import { authenticate } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
type Values = { name: string; email: string; password: string };
export function AuthForm({
  mode,
  error: initialError,
  next,
}: {
  mode: "login" | "signup" | "forgot" | "update";
  error?: string;
  next?: string;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ error?: string; message?: string }>({
    error: initialError,
  });
  const [show, setShow] = useState(false);
  const isSignup = mode === "signup",
    isUpdate = mode === "update";
  const submit = handleSubmit((values) =>
    start(async () => {
      setResult({});
      try {
        const res = await authenticate(mode, { ...values, next });
        if (res) setResult(res);
      } catch (error) {
        if (error instanceof Error && error.message === "NEXT_REDIRECT")
          throw error;
        setResult({ error: "Could not connect. Please try again." });
      }
    }),
  );
  return (
    <form onSubmit={submit} className="space-y-5">
      {mode === "login" && next && (
        <input type="hidden" name="next" value={next} />
      )}
      {isSignup && (
        <div className="space-y-2">
          <Label htmlFor="name">Your name</Label>
          <Input
            id="name"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "name-error" : undefined}
            autoComplete="name"
            placeholder="Alex Morgan"
            {...register("name", { required: "Your name is required." })}
          />
          {errors.name && (
            <p
              id="name-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {errors.name.message}
            </p>
          )}
        </div>
      )}
      {!isUpdate && (
        <div className="space-y-2">
          <Label htmlFor="email">Email address</Label>
          <Input
            id="email"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            {...register("email", { required: "Email is required." })}
          />
          {errors.email && (
            <p
              id="email-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {errors.email.message}
            </p>
          )}
        </div>
      )}
      {mode !== "forgot" && (
        <div className="space-y-2">
          <div className="flex justify-between">
            <Label htmlFor="password">
              {isUpdate ? "New password" : "Password"}
            </Label>
            {mode === "login" && (
              <Link
                href="/auth/forgot-password"
                className="text-xs font-medium text-primary"
              >
                Forgot password?
              </Link>
            )}
          </div>
          <div className="relative">
            <Input
              id="password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "password-error" : undefined}
              type={show ? "text" : "password"}
              autoComplete={
                isSignup || isUpdate ? "new-password" : "current-password"
              }
              placeholder={
                mode === "login" ? "Your password" : "At least 8 characters"
              }
              className="pr-12"
              {...register("password", {
                required: "Password is required.",
                minLength: {
                  value: mode === "login" ? 6 : 8,
                  message:
                    mode === "login"
                      ? "Use at least 6 characters."
                      : "Use at least 8 characters.",
                },
                maxLength: {
                  value: 128,
                  message: "Use at most 128 characters.",
                },
              })}
            />
            <button
              type="button"
              aria-label={show ? "Hide password" : "Show password"}
              aria-pressed={show}
              className="absolute right-0 top-0 flex size-9 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onClick={() => setShow(!show)}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {errors.password && (
            <p
              id="password-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {errors.password.message}
            </p>
          )}
        </div>
      )}
      {result.error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          {result.error}
        </p>
      )}
      {result.message && (
        <p
          role="status"
          className="flex gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <Mail size={18} className="shrink-0" />
          {result.message}
        </p>
      )}
      <Button disabled={pending} className="h-11 w-full">
        {pending ? <LoaderCircle className="animate-spin" /> : null}
        {isSignup
          ? "Create your workspace"
          : mode === "forgot"
            ? "Send reset link"
            : isUpdate
              ? "Save password"
              : "Sign in to workspace"}
        {!pending && <ArrowRight size={16} />}
      </Button>
      <p className="pt-3 text-center text-sm text-muted-foreground">
        {mode === "login" ? (
          <>
            New to Bidder Check?{" "}
            <Link className="font-semibold text-primary" href="/auth/signup">
              Create an account
            </Link>
          </>
        ) : isSignup ? (
          <>
            Already have an account?{" "}
            <Link className="font-semibold text-primary" href="/auth/login">
              Sign in
            </Link>
          </>
        ) : (
          <Link className="text-primary" href="/auth/login">
            Back to sign in
          </Link>
        )}
      </p>
      {isSignup && (
        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          Creating a client account? You’re in the right place.
          <br />
          Bidder accounts are created by their client.
        </p>
      )}
    </form>
  );
}
