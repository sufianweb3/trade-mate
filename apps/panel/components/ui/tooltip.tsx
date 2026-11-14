"use client";
import * as T from "@radix-ui/react-tooltip";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "@/lib/utils";

/** shadcn/ui Tooltip. */
export const TooltipProvider = T.Provider;
export const Tooltip = T.Root;
export const TooltipTrigger = T.Trigger;
export const TooltipContent = forwardRef<ElementRef<typeof T.Content>, ComponentPropsWithoutRef<typeof T.Content>>(({ className, sideOffset = 6, ...p }, ref) => (
  <T.Portal>
    <T.Content ref={ref} sideOffset={sideOffset} className={cn("z-50 max-w-xs rounded-md bg-fg px-2.5 py-1.5 text-xs text-bg shadow-md", className)} {...p} />
  </T.Portal>
));
TooltipContent.displayName = T.Content.displayName;
