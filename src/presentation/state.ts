export type Surface = "library" | "workspace";
export type ViewMode = "list" | "map";
export type FixtureScenario =
  | "completed"
  | "pending"
  | "failed"
  | "cancelled"
  | "status"
  | "empty"
  | "image-failure";

export type Selection = {
  dayIndex: number;
  visitId: string | null;
  legId: string | null;
};

export type PresentationState = {
  surface: Surface;
  viewMode: ViewMode;
  selection: Selection;
  conversationOpen: boolean;
  scenario: FixtureScenario;
};

export type PresentationAction =
  | { type: "open-trip" }
  | { type: "return-library" }
  | { type: "set-view"; viewMode: ViewMode }
  | { type: "select-day"; dayIndex: number }
  | { type: "select-visit"; visitId: string; dayIndex: number }
  | { type: "select-leg"; legId: string; dayIndex: number }
  | { type: "close-detail" }
  | { type: "toggle-conversation" }
  | { type: "set-scenario"; scenario: FixtureScenario };

export const initialPresentationState: PresentationState = {
  surface: "library",
  viewMode: "list",
  selection: { dayIndex: 0, visitId: null, legId: null },
  conversationOpen: true,
  scenario: "completed",
};

export function presentationReducer(
  state: PresentationState,
  action: PresentationAction,
): PresentationState {
  switch (action.type) {
    case "open-trip":
      return { ...state, surface: "workspace" };
    case "return-library":
      return { ...state, surface: "library" };
    case "set-view":
      return { ...state, viewMode: action.viewMode };
    case "select-day":
      return {
        ...state,
        selection: { dayIndex: action.dayIndex, visitId: null, legId: null },
      };
    case "select-visit":
      return {
        ...state,
        selection: { dayIndex: action.dayIndex, visitId: action.visitId, legId: null },
      };
    case "select-leg":
      return {
        ...state,
        selection: { dayIndex: action.dayIndex, visitId: null, legId: action.legId },
      };
    case "close-detail":
      return { ...state, selection: { ...state.selection, visitId: null, legId: null } };
    case "toggle-conversation":
      return { ...state, conversationOpen: !state.conversationOpen };
    case "set-scenario":
      return { ...state, scenario: action.scenario };
  }
}

export function scenarioMessage(scenario: FixtureScenario): string | null {
  switch (scenario) {
    case "pending":
      return "演示修改正在等待处理，当前仍显示原版本。";
    case "failed":
      return "演示修改未通过：第 2 天的参观时段发生冲突。原版本已保留。";
    case "cancelled":
      return "演示修改已取消，原版本未改变。";
    case "status":
      return "正在整理候选地点；这是固定阶段演示，不代表实时进度。";
    default:
      return null;
  }
}
