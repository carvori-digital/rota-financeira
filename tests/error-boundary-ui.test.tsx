import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "../src/components/ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows feedback for a render failure and remounts on retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let broken = true;
  function Screen() {
    if (broken) throw new Error("synthetic render failure");
    return <p>Aplicação recuperada</p>;
  }
  render(
    <ErrorBoundary>
      <Screen />
    </ErrorBoundary>,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Não foi possível exibir a aplicação",
  );
  broken = false;
  await userEvent.click(
    screen.getByRole("button", { name: "Tentar novamente" }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Aplicação recuperada")).toBeTruthy();
});
