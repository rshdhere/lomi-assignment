import type { ComponentProps } from "react";

// Adapted from shadcn/ui's New York Button to use the workspace theme.
export function Button({
  variant = "default",
  ...props
}: ComponentProps<"button"> & { variant?: "default" | "outline" }) {
  return <button data-slot="button" data-variant={variant} {...props} />;
}
