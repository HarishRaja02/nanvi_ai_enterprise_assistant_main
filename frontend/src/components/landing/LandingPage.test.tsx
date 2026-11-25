import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage";

describe("LandingPage", () => {
  it("renders the enterprise value proposition, hero title, and download buttons", () => {
    render(<LandingPage onLaunchWebApp={vi.fn()} />);

    // Title & Brand
    expect(screen.getByRole("heading", { level: 1, name: /Ask Questions About Your/i })).toBeInTheDocument();

    // Primary Action Buttons
    expect(screen.getAllByText(/Get (it )?from Microsoft Store/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Launch Web App|Open Web App/i).length).toBeGreaterThan(0);

    // Capabilities Section
    expect(screen.getByText(/What You Can Do With Nanvi AI/i)).toBeInTheDocument();
    expect(screen.getByText(/Invoice & Payment Tracking/i)).toBeInTheDocument();
    expect(screen.getByText(/100% Private — Files Stay Local/i)).toBeInTheDocument();

    // Dual Architecture Section
    expect(screen.getByText(/Two Ways to Use Nanvi AI/i)).toBeInTheDocument();
    expect(screen.getByText(/Windows Desktop Application/i)).toBeInTheDocument();
    expect(screen.getByText(/Cloud Web Application/i)).toBeInTheDocument();
  });

  it("calls onLaunchWebApp when the user clicks Launch Web App", async () => {
    const user = userEvent.setup();
    const mockLaunch = vi.fn();

    render(<LandingPage onLaunchWebApp={mockLaunch} />);

    const launchBtns = screen.getAllByRole("button", { name: /Launch Web App/i });
    expect(launchBtns.length).toBeGreaterThan(0);

    await user.click(launchBtns[0]);
    expect(mockLaunch).toHaveBeenCalled();
  });

  it("renders the showcase demo video on the homepage", () => {
    render(<LandingPage onLaunchWebApp={vi.fn()} />);

    const demoSection = screen.getByLabelText(/Product Interface Demo/i);
    expect(demoSection).toBeInTheDocument();

    const video = demoSection.querySelector("video");
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute("src", "/User_generating_answer_in_AI_60d2eb4b.mp4");
  });
});
