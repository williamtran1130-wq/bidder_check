import type { ComponentProps } from "react";
export default function Link({ prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) {
  void prefetch;
  return <a {...props} />;
}
