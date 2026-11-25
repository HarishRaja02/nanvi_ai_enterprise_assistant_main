import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NanviApiClient, UserIdentity } from "../../api";
import { ToastProvider } from "../../components/ui/Toast";
import { AccountManagement } from "./AccountManagement";

const supervisor: UserIdentity = {
  subject: "supervisor-1",
  issuer: "nanvi-local",
  roles: ["Supervisor"],
  tenant_id: "tenant-1",
};

const superior: UserIdentity = {
  subject: "superior-1",
  issuer: "nanvi-local",
  roles: ["Superior"],
  tenant_id: "tenant-1",
};

describe("AccountManagement", () => {
  it("limits Supervisor account creation and removal to Project Engineer and Employee", async () => {
  it("limits Supervisor account creation and removal to Project Engineer, Employee, and Intern", async () => {
    const user = userEvent.setup();
    const createLocalAccount = vi.fn().mockResolvedValue({});
    const deleteLocalAccount = vi.fn().mockResolvedValue(undefined);
    const listLocalAccounts = vi.fn().mockResolvedValue([{
      id: "employee-1",
      username: "employee.one",
      role: "Employee",
      display_name: "Employee One",
      department: "Operations",
      active: true,
      created_at: "2026-11-18 10:00:00",
    }]);
    const api = { createLocalAccount, deleteLocalAccount, listLocalAccounts } as unknown as NanviApiClient;
    render(<AccountManagement api={api} identity={supervisor} />);

    const roleSelect = screen.getByRole("combobox", { name: "Role" });
    expect(roleSelect.querySelectorAll("option")).toHaveLength(2);
    expect(screen.queryByRole("option", { name: "Superior" })).not.toBeInTheDocument();
    expect(roleSelect.querySelectorAll("option")).toHaveLength(3);
    expect(screen.getByRole("option", { name: /Tier 5 — Intern \/ Trainee/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Tier 1/i })).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "User ID" }), "project.eng");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Project Engineer");
    await user.type(screen.getByLabelText("Temporary password"), "secure-project-password");
    await user.type(screen.getByRole("textbox", { name: "Email ID" }), "project.eng@company.com");
    await user.selectOptions(roleSelect, "Project Engineer");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(createLocalAccount).toHaveBeenCalledWith(expect.objectContaining({
      username: "project.eng",
      role: "Project Engineer",
      display_name: "Project Engineer",
      email: "project.eng@company.com",
    })));

    await screen.findByText("Employee One");
    await user.click(screen.getByRole("button", { name: "Remove employee.one" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(deleteLocalAccount).toHaveBeenCalledWith("employee-1"));
  });

  it("enforces required Email ID and blocks creation without it", async () => {
    const user = userEvent.setup();
    const createLocalAccount = vi.fn().mockResolvedValue({});
    const api = {
      listLocalAccounts: vi.fn().mockResolvedValue([]),
      createLocalAccount,
    } as unknown as NanviApiClient;

    render(<AccountManagement api={api} identity={superior} />);

    const emailInput = screen.getByRole("textbox", { name: "Email ID" });
    expect(emailInput).toBeRequired();

    await user.type(screen.getByRole("textbox", { name: "User ID" }), "valid.user");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Valid User");
    await user.type(screen.getByLabelText("Temporary password"), "secure-project-password");
    // Leave email empty and attempt submit
    await user.click(screen.getByRole("button", { name: "Create account" }));

    // Form submission is blocked by required constraint
    expect(createLocalAccount).not.toHaveBeenCalled();

    // Type invalid email
    await user.type(emailInput, "not-an-email");
    expect(screen.getByText(/Please provide a valid corporate email address/i)).toBeInTheDocument();
  });

  it("removes the sentence 'Create an account for any role.' when Superior views create account", async () => {
    const api = {
      listLocalAccounts: vi.fn().mockResolvedValue([]),
      listDepartments: vi.fn().mockResolvedValue(["Operations"]),
    } as unknown as NanviApiClient;

    render(<AccountManagement api={api} identity={superior} />);
    expect(screen.queryByText(/Create an account for any role/i)).not.toBeInTheDocument();
  });

  it("provides proper placeholders for User ID, Name, and Email ID", () => {
    const api = {
      listLocalAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as NanviApiClient;

    render(<AccountManagement api={api} identity={superior} />);

    const userIdInput = screen.getByPlaceholderText("e.g. jdoe or emp_1042");
    expect(userIdInput).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText("e.g. John Doe");
    expect(nameInput).toBeInTheDocument();

    const emailInput = screen.getByPlaceholderText("e.g. john.doe@company.com");
    expect(emailInput).toBeInTheDocument();
  });

  it("prevents spaces and invalid characters in User ID and Name fields", async () => {
    const user = userEvent.setup();
    const api = {
      listLocalAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as NanviApiClient;

    render(<AccountManagement api={api} identity={superior} />);

    const userIdInput = screen.getByPlaceholderText("e.g. jdoe or emp_1042");
    const nameInput = screen.getByPlaceholderText("e.g. John Doe");

    // Attempt typing space and invalid characters in User ID
    await user.type(userIdInput, "john doe!#$");
    // Spaces and symbols must be stripped, leaving only valid chars
    expect(userIdInput).toHaveValue("johndoe");

    // Attempt typing numbers or symbols in Name
    await user.type(nameInput, "John 123 Doe$$");
    expect(nameInput).toHaveValue("John  Doe");
  });

  it("toggles password visibility with Show/Hide password icon", async () => {
    const user = userEvent.setup();
    const api = {
      listLocalAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as NanviApiClient;

    render(<AccountManagement api={api} identity={superior} />);

    const passwordInput = screen.getByLabelText("Temporary password");
    expect(passwordInput).toHaveAttribute("type", "password");

    const toggleBtn = screen.getByRole("button", { name: "Show password" });
    await user.click(toggleBtn);

    expect(passwordInput).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(passwordInput).toHaveAttribute("type", "password");
  });

  it("allows customizable department creation and adds it to selection list", async () => {
    const user = userEvent.setup();
    const addDepartment = vi.fn().mockResolvedValue(["Engineering", "Operations", "Robotics"]);
    const listDepartments = vi.fn().mockResolvedValue(["Engineering", "Operations"]);
    const api = {
      listLocalAccounts: vi.fn().mockResolvedValue([]),
      listDepartments,
      addDepartment,
    } as unknown as NanviApiClient;

    render(<AccountManagement api={api} identity={superior} />);

    // Click "New" department trigger
    await user.click(screen.getByRole("button", { name: "New" }));
    const newDeptInput = screen.getByPlaceholderText("Enter new department name");
    await user.type(newDeptInput, "Robotics");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(addDepartment).toHaveBeenCalledWith("Robotics"));
    expect(screen.getByRole("combobox", { name: "Department" })).toHaveValue("Robotics");
  });

  it("displays accounts in a structured table with Name, Role, Created Date, and Delete / Update / Revoke actions", async () => {
    const user = userEvent.setup();
    const updateLocalAccount = vi.fn().mockResolvedValue({});
    const api = {
      listLocalAccounts: vi.fn().mockResolvedValue([{
        id: "emp-42",
        username: "clara.oswald",
        role: "Project Engineer",
        display_name: "Clara Oswald",
        email: "clara@tardis.com",
        department: "Quantum Physics",
        active: true,
        created_at: "2026-11-18 12:00:00",
      }]),
      updateLocalAccount,
    } as unknown as NanviApiClient;

    render(<AccountManagement api={api} identity={superior} />);

    // Table headers
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Role" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Created Date" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();

    // Table data
    await screen.findByText("Clara Oswald");
    expect(screen.getByText("@clara.oswald")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("Quantum Physics");
    expect(screen.getByRole("table")).toHaveTextContent("Project Engineer");
    expect(screen.getByRole("table")).toHaveTextContent("Tier 3 — Project Manager / Team Lead");
    expect(screen.getByText("Active")).toBeInTheDocument();

    // Actions visible
    expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove clara\.oswald/i })).toBeInTheDocument();

    // Revoke action
    await user.click(screen.getByRole("button", { name: /revoke/i }));
    await user.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(updateLocalAccount).toHaveBeenCalledWith("emp-42", { active: false }));
  });

  it("supports updating an account through the update modal dialog", async () => {
    const user = userEvent.setup();
    const updateLocalAccount = vi.fn().mockResolvedValue({});
    const api = {
      listLocalAccounts: vi.fn().mockResolvedValue([{
        id: "emp-99",
        username: "rory.williams",
        role: "Employee",
        display_name: "Rory Williams",
        email: "rory@nurse.com",
        department: "Medical",
        active: true,
        created_at: "2026-11-18 12:00:00",
      }]),
      updateLocalAccount,
    } as unknown as NanviApiClient;

    render(<AccountManagement api={api} identity={superior} />);

    await screen.findByText("Rory Williams");
    await user.click(screen.getByRole("button", { name: /update/i }));

    // Modal is open
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Update Account — @rory.williams/i)).toBeInTheDocument();

    const nameInput = screen.getByRole("dialog").querySelector("input[value='Rory Williams']") as HTMLInputElement;
    expect(nameInput).toBeInTheDocument();
    await user.clear(nameInput);
    await user.type(nameInput, "Rory Arthur Williams");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateLocalAccount).toHaveBeenCalledWith("emp-99", expect.objectContaining({
      display_name: "Rory Arthur Williams",
    })));
  });

  it("shows popup toast notifications after creation, updation, revoke/restore, deletion, and errors", async () => {
    const user = userEvent.setup();
    const accountRecord = {
      id: "acc-1",
      username: "janu",
      role: "Project Engineer" as const,
      display_name: "Janu",
      email: "hazelrish@gmail.com",
      department: "Information Technology",
      active: true,
      created_at: "2026-11-24 10:00:00",
    };
    const createLocalAccount = vi.fn().mockResolvedValue({ ...accountRecord, id: "acc-2", username: "sylvia" });
    const updateLocalAccount = vi.fn().mockResolvedValue({ ...accountRecord, display_name: "Janu R" });
    const deleteLocalAccount = vi.fn().mockResolvedValue(undefined);
    const addDepartment = vi.fn().mockResolvedValue(["Information Technology", "Security"]);
    const listLocalAccounts = vi.fn().mockResolvedValue([accountRecord]);

    const api = {
      listLocalAccounts,
      createLocalAccount,
      updateLocalAccount,
      deleteLocalAccount,
      addDepartment,
    } as unknown as NanviApiClient;

    render(
      <ToastProvider>
        <AccountManagement api={api} identity={superior} />
      </ToastProvider>
    );

    const toastRegion = () => screen.getByRole("region", { name: "Notifications" });

    // 1. Department creation popup
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.type(screen.getByPlaceholderText("Enter new department name"), "Security");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(within(toastRegion()).getByText(/Department "Security" added successfully\./i)).toBeInTheDocument()
    );

    // 2. Account creation popup
    await user.type(screen.getByRole("textbox", { name: "User ID" }), "sylvia");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "sylvia");
    await user.type(screen.getByRole("textbox", { name: "Email ID" }), "sylvia.nanvitech@gmail.com");
    await user.type(screen.getByLabelText("Temporary password"), "secure-password-123");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(within(toastRegion()).getByText(/Account "@sylvia" \(sylvia\) created successfully!/i)).toBeInTheDocument()
    );

    // 3. Account updation popup
    await screen.findByText("Janu");
    await user.click(screen.getByRole("button", { name: /Update/i }));
    const nameInput = screen.getByRole("dialog").querySelector("input[value='Janu']") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Janu R");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(within(toastRegion()).getByText(/Account "@janu" updated successfully\./i)).toBeInTheDocument()
    );

    // 4. Revoke access popup
    await user.click(screen.getByRole("button", { name: /Revoke/i }));
    await user.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() =>
      expect(within(toastRegion()).getByText(/Access revoked for "@janu"\./i)).toBeInTheDocument()
    );

    // 5. Account deletion popup (also test API error popup first, then success)
    deleteLocalAccount.mockRejectedValueOnce(new Error("Delete forbidden"));
    await user.click(screen.getByRole("button", { name: "Remove janu" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(within(toastRegion()).getByText(/Delete forbidden/i)).toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(within(toastRegion()).getByText(/Account "@janu" deleted successfully\./i)).toBeInTheDocument()
    );
  });
  }, 20000);
});
