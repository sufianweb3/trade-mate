import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, ConfirmDialog, List, ListRow, Signed } from "@/components/ui";
import { usd } from "@/lib/format";

describe("ui components", () => {
  it("Signed keeps sign and tone", () => {
    render(<><Signed v="-12.5" fmt={(v) => usd(v, true)} /><Signed v="3" fmt={(v) => usd(v, true)} /></>);
    const neg = screen.getByText(usd("-12.5", true));
    const pos = screen.getByText(usd("3", true));
    expect(neg.textContent).toMatch(/^[−-]/);
    expect(neg.className).toContain("text-neg");
    expect(pos.textContent).toMatch(/^\+/);
    expect(pos.className).toContain("text-pos");
  });

  it("Button has focus-visible ring and press feedback, no transition-all", () => {
    render(<Button>Go</Button>);
    const b = screen.getByRole("button", { name: "Go" });
    expect(b.className).toContain("focus-visible:");
    expect(b.className).toContain("active:scale-");
    expect(b.className).not.toContain("transition-all");
  });

  it("ConfirmDialog calls onConfirm only after confirm", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Kill switch?" body="Closes everything." confirmLabel="Close all + stop" tone="danger" onConfirm={onConfirm} trigger={<Button>Kill switch</Button>} />);
    fireEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close all + stop" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("List renders rows with label and value", () => {
    render(<List><ListRow label="Open positions" value="2" /></List>);
    expect(screen.getByText("Open positions")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });
});
