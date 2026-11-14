"use client";
import * as A from "@radix-ui/react-alert-dialog";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

/** shadcn/ui AlertDialog: confirmations for actions that move money (kill switch, Live start, close position). */
export const AlertDialog = A.Root;
export const AlertDialogTrigger = A.Trigger;
export const AlertDialogPortal = A.Portal;

export const AlertDialogOverlay = forwardRef<ElementRef<typeof A.Overlay>, ComponentPropsWithoutRef<typeof A.Overlay>>(({ className, ...p }, ref) => (
  <A.Overlay ref={ref} className={cn("fixed inset-0 z-50 bg-black/40", className)} {...p} />
));
AlertDialogOverlay.displayName = A.Overlay.displayName;

export const AlertDialogContent = forwardRef<ElementRef<typeof A.Content>, ComponentPropsWithoutRef<typeof A.Content>>(({ className, ...p }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <A.Content
      ref={ref}
      className={cn("fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-xl focus-visible:outline-none", className)}
      {...p}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = A.Content.displayName;

export const AlertDialogHeader = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn("space-y-1.5", className)} {...p} />;
export const AlertDialogFooter = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn("mt-5 flex justify-end gap-2", className)} {...p} />;

export const AlertDialogTitle = forwardRef<ElementRef<typeof A.Title>, ComponentPropsWithoutRef<typeof A.Title>>(({ className, ...p }, ref) => (
  <A.Title ref={ref} className={cn("text-[17px] font-semibold tracking-tight", className)} {...p} />
));
AlertDialogTitle.displayName = A.Title.displayName;

export const AlertDialogDescription = forwardRef<ElementRef<typeof A.Description>, ComponentPropsWithoutRef<typeof A.Description>>(({ className, ...p }, ref) => (
  <A.Description ref={ref} className={cn("text-sm text-muted", className)} {...p} />
));
AlertDialogDescription.displayName = A.Description.displayName;

export const AlertDialogAction = forwardRef<ElementRef<typeof A.Action>, ComponentPropsWithoutRef<typeof A.Action>>(({ className, ...p }, ref) => (
  <A.Action ref={ref} className={cn(buttonVariants({ variant: "primary" }), className)} {...p} />
));
AlertDialogAction.displayName = A.Action.displayName;

export const AlertDialogCancel = forwardRef<ElementRef<typeof A.Cancel>, ComponentPropsWithoutRef<typeof A.Cancel>>(({ className, ...p }, ref) => (
  <A.Cancel ref={ref} className={cn(buttonVariants({ variant: "default" }), className)} {...p} />
));
AlertDialogCancel.displayName = A.Cancel.displayName;
