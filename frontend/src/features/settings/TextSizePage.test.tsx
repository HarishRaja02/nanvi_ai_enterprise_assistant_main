import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TextSizePage } from "./TextSizePage";

describe("TextSizePage", () => {
  it("renders modern font scaling controls and live reading preview", () => {
    const onFontScaleChange = vi.fn();
    render(<TextSizePage fontScale={1} onFontScaleChange={onFontScaleChange} />);

    expect(screen.getByRole("heading", { name: "Text Size" })).toBeInTheDocument();
    expect(screen.getAllByText("100%").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("region", { name: "Reading Preview" })).toBeInTheDocument();

    // Verify unnecessary text is NOT present
    expect(screen.queryByText(/Enterprise Cloud Connection/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Vercel Live/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/nanviaienterpriseassistant.vercel.app/i)).not.toBeInTheDocument();
  });

  it("updates text size when preset buttons are clicked", async () => {
    const user = userEvent.setup();
    const onFontScaleChange = vi.fn();
    render(<TextSizePage fontScale={1} onFontScaleChange={onFontScaleChange} />);

    const compactBtn = screen.getByRole("radio", { name: /Compact/i });
    await user.click(compactBtn);
    expect(onFontScaleChange).toHaveBeenCalledWith(0.9);

    const largeBtn = screen.getByRole("radio", { name: /Comfortable/i });
    await user.click(largeBtn);
    expect(onFontScaleChange).toHaveBeenCalledWith(1.2);
  });

  it("increments and decrements using stepper buttons and resets to default", async () => {
    const user = userEvent.setup();
    const onFontScaleChange = vi.fn();
    render(<TextSizePage fontScale={1.1} onFontScaleChange={onFontScaleChange} />);

    const decreaseBtn = screen.getByRole("button", { name: "Decrease text size" });
    await user.click(decreaseBtn);
    expect(onFontScaleChange).toHaveBeenCalledWith(1);

    const increaseBtn = screen.getByRole("button", { name: "Increase text size" });
    await user.click(increaseBtn);
    expect(onFontScaleChange).toHaveBeenCalledWith(1.2);

    const resetBtn = screen.getByRole("button", { name: /Reset to default/i });
    await user.click(resetBtn);
    expect(onFontScaleChange).toHaveBeenCalledWith(1);
  });
});
