"use server";
import { createClient } from "@/lib/server";
import { z } from "zod";
import { redirect } from "next/navigation";
const credentials = z.object({
  email: z.email(),
  password: z.string().min(6, "Use at least 6 characters.").max(128),
  name: z.string().max(100).optional(),
});
export async function authenticate(
  mode: string,
  values: { email: string; password: string; name?: string; next?: string },
) {
  const supabase = await createClient();
  if (mode === "forgot") {
    return {
      error: "Contact your client or administrator to recover your account.",
    };
  }
  if (mode === "update") {
    if (values.password.length < 8 || values.password.length > 128)
      return { error: "Use between 8 and 128 characters." };
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user)
      return {
        error: "Please sign in before changing your password.",
      };
    const { error } = await supabase.auth.updateUser({
      password: values.password,
    });
    if (error) return { error: error.message };
    redirect("/dashboard");
  }
  const parsed = credentials.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (mode === "signup") {
    if (values.password.length < 8)
      return { error: "Use at least 8 characters." };
    const { data, error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        data: { display_name: values.name },
      },
    });
    if (error) return { error: error.message };
    if (data.session) redirect("/dashboard");
    return {
      error:
        "Account created, but immediate sign-in is unavailable. Contact your administrator.",
    };
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: values.email,
    password: values.password,
  });
  if (error) return { error: error.message };
  const next = values.next;
  // Only allow same-origin relative paths. This preserves protected deep links
  // without creating an open redirect.
  if (next?.startsWith("/") && !next.startsWith("//") && !next.includes("\\")) {
    redirect(next);
  }
  redirect("/dashboard");
}
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/auth/login");
}
