"use client";
import * as T from "@radix-ui/react-toggle-group";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "@/lib/utils";

/** shadcn/ui ToggleGroup styled as an Apple segmented control. */
export const ToggleGroup = forwardRef<ElementRef<typeof T.Root>, ComponentPropsWithoutRef<typeof T.Root>>(({ className, ...p }, ref) => (
  <T.Root ref={ref} className={cn("inline-flex items-center rounded-lg bg-line/50 p-0.5", className)} {...p} />
));
ToggleGroup.displayName = T.Root.displayName;

export const ToggleGroupItem = forwardRef<ElementRef<typeof T.Item>, ComponentPropsWithoutRef<typeof T.Item>>(({ className, ...p }, ref) => (
  <T.Item
    ref={ref}
    className={cn("rounded-md px-3 py-1 text-sm font-medium text-muted transition-colors duration-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-surface data-[state=on]:text-foreground data-[state=on]:shadow-sm", className)}
    {...p}
  />
));
ToggleGroupItem.displayName = T.Item.displayName;
