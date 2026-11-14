"use client";
import * as S from "@radix-ui/react-switch";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "@/lib/utils";

/** shadcn/ui Switch: mint when on. */
export const ShadSwitch = forwardRef<ElementRef<typeof S.Root>, ComponentPropsWithoutRef<typeof S.Root>>(({ className, ...p }, ref) => (
  <S.Root
    ref={ref}
    className={cn("peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:bg-accent data-[state=unchecked]:bg-line", className)}
    {...p}
  >
    <S.Thumb className="pointer-events-none block h-5 w-5 rounded-full bg-white shadow transition-transform duration-150 data-[state=checked]:translate-x-[17px] data-[state=unchecked]:translate-x-0.5 motion-reduce:transition-none" />
  </S.Root>
));
ShadSwitch.displayName = S.Root.displayName;
