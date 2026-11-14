import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** shadcn/ui Button (new-york), Trade Mate tokens. Press feedback on pointer-down, focus ring on keyboard focus. */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium select-none transition-[background-color,color,box-shadow,transform] duration-100 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 motion-reduce:transform-none",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground border border-border hover:bg-line/60",
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        danger: "bg-neg/10 text-neg hover:bg-neg/20",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        ghost: "text-foreground hover:bg-line/50",
      },
      size: { sm: "h-8 px-3 text-xs", md: "h-9 px-4 text-sm" },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const ShadButton = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const C = asChild ? Slot : "button";
  return <C ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
ShadButton.displayName = "Button";
