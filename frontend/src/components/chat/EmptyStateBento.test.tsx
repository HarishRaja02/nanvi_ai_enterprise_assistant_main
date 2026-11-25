import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyStateBento } from "./EmptyStateBento";

describe("EmptyStateBento", () => {
  it("renders clean greeting and composer without hardcoded suggested questions", () => {
    render(<EmptyStateBento composer={<input aria-label="Ask Nanvi" />} />);

    expect(screen.getByRole("heading", { name: "How can I help you today?" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask Nanvi" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Suggested questions" })).not.toBeInTheDocument();
  });
});