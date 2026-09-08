import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, Fragment, useState } from "react";
import { initialPresentationState, presentationReducer, scenarioMessage } from "@/presentation/state";
import { Modal } from "@/components/modal";

describe("presentationReducer", () => {
  it("preserves day and Visit selection when switching projections", () => {
    const selected = presentationReducer(initialPresentationState, {
      type: "select-visit",
      dayIndex: 2,
      visitId: "visit_temple-of-heaven",
    });
    const mapped = presentationReducer(selected, { type: "set-view", viewMode: "map" });
    expect(mapped.selection).toEqual({ dayIndex: 2, visitId: "visit_temple-of-heaven", legId: null });
    expect(mapped.viewMode).toBe("map");
  });

  it("keeps selection while the conversation panel is toggled", () => {
    const selected = presentationReducer(initialPresentationState, {
      type: "select-leg",
      dayIndex: 1,
      legId: "leg_forbidden-city-to-jingshan",
    });
    const toggled = presentationReducer(selected, { type: "toggle-conversation" });
    expect(toggled.selection).toEqual(selected.selection);
    expect(toggled.conversationOpen).toBe(false);
  });

  it("clears detail selection when changing days", () => {
    const selected = presentationReducer(initialPresentationState, {
      type: "select-visit",
      dayIndex: 1,
      visitId: "visit_forbidden-city",
    });
    const changed = presentationReducer(selected, { type: "select-day", dayIndex: 3 });
    expect(changed.selection).toEqual({ dayIndex: 3, visitId: null, legId: null });
  });

  it("describes failed and cancelled fixture changes as preserving the old version", () => {
    expect(scenarioMessage("failed")).toContain("原版本已保留");
    expect(scenarioMessage("cancelled")).toContain("原版本未改变");
  });
});

describe("Modal", () => {
  it("does not steal input focus on rerender and restores the opener after Escape", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const [value, setValue] = useState("");
      return createElement(
        Fragment,
        null,
        createElement("button", { type: "button", onClick: () => setOpen(true) }, "打开测试对话框"),
        open && createElement(
          Modal,
          { title: "测试对话框", onClose: () => setOpen(false) },
          createElement("input", {
            "aria-label": "测试输入",
            value,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
          }),
        ),
      );
    }

    render(createElement(Harness));
    const opener = screen.getByRole("button", { name: "打开测试对话框" });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByRole("textbox", { name: "测试输入" });
    input.focus();
    fireEvent.change(input, { target: { value: "北京" } });
    expect(input).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(opener).toHaveFocus();
    cleanup();
  });
});
