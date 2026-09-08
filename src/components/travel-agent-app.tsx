"use client";

import { beijingFixture } from "@/fixtures/beijing";
import { initialPresentationState, presentationReducer, type FixtureScenario } from "@/presentation/state";
import { CalendarRange, FlaskConical } from "lucide-react";
import { useReducer } from "react";
import { ItineraryWorkspace } from "./itinerary-workspace";
import { TripLibrary } from "./trip-library";

const scenarios: { value: FixtureScenario; label: string }[] = [
  { value: "completed", label: "完成" },
  { value: "pending", label: "等待中" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
  { value: "status", label: "阶段状态" },
  { value: "empty", label: "空列表" },
  { value: "image-failure", label: "图片失败" },
];

export function TravelAgentApp() {
  const [state, dispatch] = useReducer(presentationReducer, initialPresentationState);
  return (
    <div className="app-shell">
      <aside className="app-rail" aria-label="主导航">
        <div className="brand" aria-label="行旅"><CalendarRange aria-hidden="true" size={21} /><span>行旅</span></div>
        <nav><button className="rail-item active" type="button" onClick={() => dispatch({ type: "return-library" })}><CalendarRange aria-hidden="true" size={18} /><span>行程</span></button></nav>
        <div className="fixture-control">
          <label htmlFor="fixture-scenario"><FlaskConical aria-hidden="true" size={15} />演示状态</label>
          <select id="fixture-scenario" value={state.scenario} onChange={(event) => dispatch({ type: "set-scenario", scenario: event.target.value as FixtureScenario })} data-testid="fixture-scenario">
            {scenarios.map((scenario) => <option value={scenario.value} key={scenario.value}>{scenario.label}</option>)}
          </select>
        </div>
      </aside>
      <div className="app-content">
        {state.surface === "library" ? (
          <TripLibrary
            version={beijingFixture}
            scenario={state.scenario}
            onOpenTrip={() => dispatch({ type: "open-trip" })}
            onOpenMap={() => { dispatch({ type: "set-view", viewMode: "map" }); dispatch({ type: "open-trip" }); }}
          />
        ) : (
          <ItineraryWorkspace version={beijingFixture} state={state} dispatch={dispatch} />
        )}
      </div>
    </div>
  );
}
