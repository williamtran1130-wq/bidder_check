import { Earnings } from "@/components/earnings";
import { getContext } from "@/lib/auth";
import { redirect } from "next/navigation";
export default async function Page() {
  const { profile } = await getContext();
  if (profile.role === "bidder") redirect("/dashboard");
  return <Earnings />;
}
