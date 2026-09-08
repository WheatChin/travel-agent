"use client";

import type { DayPlan, ItineraryVersion, Leg, Place, Visit } from "@/domain/contracts";
import type { FixtureScenario, PresentationAction, PresentationState } from "@/presentation/state";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Bus,
  ChevronRight,
  Footprints,
  Info,
  List,
  Lock,
  Map as MapIcon,
  MessageSquareText,
  Pencil,
  Route,
  X,
} from "lucide-react";
import { useMemo, useState, type Dispatch } from "react";
import { ConversationPanel } from "./conversation-panel";
import { Modal } from "./modal";
import { PhotoCredits } from "./photo-credits";
import { PlaceImage } from "./place-image";

type WorkspaceProps = {
  version: ItineraryVersion;
  state: PresentationState;
  dispatch: Dispatch<PresentationAction>;
};

const modeLabels: Record<Leg["mode"], string> = {
  walk: "步行",
  public_transit: "公共交通",
  taxi: "出租车",
  drive: "驾车",
  bicycle: "骑行",
};

function byId<T extends { id: string }>(items: readonly T[], id: string | null): T | undefined {
  return id ? items.find((item) => item.id === id) : undefined;
}

function VisitCard({ visit, place, selected, forceFailure, onSelect }: {
  visit: Visit;
  place: Place;
  selected: boolean;
  forceFailure: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`visit-card ${selected ? "selected" : ""}`} type="button" onClick={onSelect} aria-pressed={selected} data-testid={`visit-${visit.id}`}>
      <span className="visit-time"><strong>{visit.startTime}</strong><span>{visit.endTime}</span></span>
      <PlaceImage src={place.imageSrc} alt={place.imageAlt} forceFailure={forceFailure} className="visit-image" />
      <span className="visit-copy">
        <span className="visit-title">{place.name}{visit.locked && <Lock aria-label="已锁定" size={13} />}</span>
        <span>{place.district} · {visit.durationMinutes} 分钟</span>
        <span>{place.description}</span>
      </span>
      <ChevronRight aria-hidden="true" size={18} />
    </button>
  );
}

function LegRow({ leg, selected, onSelect }: { leg: Leg; selected: boolean; onSelect: () => void }) {
  const Icon = leg.mode === "walk" ? Footprints : Bus;
  const facts = leg.durationMinutes === null && leg.distanceMeters === null
    ? "路线数据未接入"
    : `${leg.durationMinutes ?? "未知"} 分钟 · ${leg.distanceMeters ?? "未知"} 米`;
  return (
    <button className={`leg-row ${selected ? "selected" : ""}`} type="button" onClick={onSelect} aria-pressed={selected} data-testid={`leg-${leg.id}`}>
      <Icon aria-hidden="true" size={16} /><span>{modeLabels[leg.mode]} · {facts}</span><ChevronRight aria-hidden="true" size={15} />
    </button>
  );
}

function Timeline({ version, days, state, dispatch }: WorkspaceProps & { days: readonly DayPlan[] }) {
  const places = new Map(version.places.map((place) => [place.id, place]));
  return (
    <div className="timeline" data-testid="itinerary-list">
      {days.map((day) => (
        <section className="day-section" id={`day-${day.dayIndex}`} key={day.id}>
          <header className="day-heading">
            <span className={`day-number day-${day.dayIndex}`}>D{day.dayIndex}</span>
            <div><h2>第 {day.dayIndex} 天 · {day.title}</h2><p>{day.summary}</p></div>
          </header>
          <div className="day-timeline">
            {day.visits.map((visit, index) => {
              const place = places.get(visit.placeId);
              if (!place) return null;
              const leg = day.legs[index];
              return (
                <div className="timeline-unit" key={visit.id}>
                  <VisitCard visit={visit} place={place} selected={state.selection.visitId === visit.id} forceFailure={state.scenario === "image-failure"} onSelect={() => dispatch({ type: "select-visit", visitId: visit.id, dayIndex: day.dayIndex })} />
                  {leg && <LegRow leg={leg} selected={state.selection.legId === leg.id} onSelect={() => dispatch({ type: "select-leg", legId: leg.id, dayIndex: day.dayIndex })} />}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function MapShell({ version, days, state, dispatch }: WorkspaceProps & { days: readonly DayPlan[] }) {
  const places = new Map(version.places.map((place) => [place.id, place]));
  const visits = days.flatMap((day) => day.visits.map((visit) => ({ day, visit, place: places.get(visit.placeId)! })));
  return (
    <section className="map-shell" aria-label="地图演示" data-testid="map-shell">
      <div className="map-grid" aria-hidden="true"><span>地图服务未连接</span></div>
      <div className="map-marker-list" aria-label="演示地点列表">
        {visits.map(({ day, visit, place }, index) => (
          <button key={visit.id} type="button" className={`map-marker day-${day.dayIndex} ${state.selection.visitId === visit.id ? "selected" : ""}`} onClick={() => dispatch({ type: "select-visit", visitId: visit.id, dayIndex: day.dayIndex })} aria-label={`选择地点 ${index + 1}：${place.name}`} aria-pressed={state.selection.visitId === visit.id} data-testid={`marker-${visit.id}`}>
            <span>{index + 1}</span><strong>{place.name}</strong><small>第 {day.dayIndex} 天</small>
          </button>
        ))}
      </div>
      <p className="map-disclaimer"><Info aria-hidden="true" size={15} />编号用于关联行程；布局不代表真实坐标，也未绘制路线。</p>
    </section>
  );
}

function SelectionDetail({ version, state, dispatch, onEdit }: WorkspaceProps & { onEdit: () => void }) {
  const allVisits = version.days.flatMap((day) => day.visits);
  const allLegs = version.days.flatMap((day) => day.legs);
  const visit = byId(allVisits, state.selection.visitId);
  const leg = byId(allLegs, state.selection.legId);
  const place = visit ? byId(version.places, visit.placeId) : undefined;
  const fromVisit = leg ? byId(allVisits, leg.fromVisitId) : undefined;
  const toVisit = leg ? byId(allVisits, leg.toVisitId) : undefined;
  const fromPlace = fromVisit ? byId(version.places, fromVisit.placeId) : undefined;
  const toPlace = toVisit ? byId(version.places, toVisit.placeId) : undefined;
  if (!visit && !leg) return null;

  return (
    <aside className="detail-panel" aria-label={visit ? "地点详情" : "行程段详情"} data-testid="selection-detail">
      <button className="icon-button detail-close" type="button" onClick={() => dispatch({ type: "close-detail" })} aria-label="关闭详情" title="关闭详情"><X aria-hidden="true" size={18} /></button>
      {visit && place ? (
        <>
          <PlaceImage src={place.imageSrc} alt={place.imageAlt} forceFailure={state.scenario === "image-failure"} className="detail-image" />
          <span className="fixture-badge">地点演示资料</span>
          <h2>{place.name}</h2>
          <p>{place.description}</p>
          <dl><div><dt>计划时间</dt><dd>{visit.startTime}–{visit.endTime}</dd></div><div><dt>计划停留</dt><dd>{visit.durationMinutes} 分钟</dd></div><div><dt>地点区域</dt><dd>{place.district}</dd></div></dl>
          <button className="primary-button full-button" type="button" onClick={onEdit} data-testid="open-edit-dialog"><Pencil aria-hidden="true" size={16} />演示编辑</button>
        </>
      ) : leg ? (
        <>
          <span className="detail-icon"><Route aria-hidden="true" size={22} /></span>
          <span className="fixture-badge">行程段示例</span>
          <h2>{fromPlace?.name ?? "起点"} → {toPlace?.name ?? "终点"}</h2>
          <p>仅显示该 Leg 已记录的交通事实。</p>
          <dl><div><dt>交通方式</dt><dd>{modeLabels[leg.mode]}</dd></div><div><dt>时长</dt><dd>{leg.durationMinutes === null ? "未提供" : `${leg.durationMinutes} 分钟`}</dd></div><div><dt>距离</dt><dd>{leg.distanceMeters === null ? "未提供" : `${leg.distanceMeters} 米`}</dd></div><div><dt>路线几何</dt><dd>{leg.geometry === null ? "未接入" : "已提供"}</dd></div></dl>
        </>
      ) : null}
    </aside>
  );
}

function EditModal({ scenario, visitId, versionId, onClose }: { scenario: FixtureScenario; visitId: string; versionId: string; onClose: () => void }) {
  const [submitted, setSubmitted] = useState(false);
  const [action, setAction] = useState<"duration" | "lock" | "remove">("duration");
  const [durationMinutes, setDurationMinutes] = useState(120);
  const outcome: Record<FixtureScenario, string> = {
    completed: "演示命令已完成展示，但没有提交后端，当前版本未改变。",
    pending: "演示命令正在等待处理，当前版本继续显示。",
    failed: "演示命令被拒绝：计划时段冲突。当前版本已保留。",
    cancelled: "演示命令已取消。当前版本已保留。",
    status: "阶段演示期间不提交修改。当前版本已保留。",
    empty: "空列表演示期间不提交修改。",
    "image-failure": "图片失败状态不影响行程版本。",
  };
  const command = action === "duration"
    ? `update_visit_duration(${visitId}, ${durationMinutes} 分钟)`
    : action === "lock"
      ? `set_visit_lock(${visitId}, true)`
      : `remove_visit(${visitId})`;
  return (
    <Modal title="演示编辑行程" description="这是固定 Typed Command 界面，不会修改当前不可变版本。" onClose={onClose} testId="edit-visit-dialog">
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); setSubmitted(true); }}>
        <fieldset><legend>修改类型</legend><label className="radio-row"><input type="radio" name="command" checked={action === "duration"} onChange={() => { setAction("duration"); setSubmitted(false); }} />调整停留时长</label><label className="radio-row"><input type="radio" name="command" checked={action === "lock"} onChange={() => { setAction("lock"); setSubmitted(false); }} />锁定地点</label><label className="radio-row"><input type="radio" name="command" checked={action === "remove"} onChange={() => { setAction("remove"); setSubmitted(false); }} />移除地点</label></fieldset>
        {action === "duration" && <label>停留分钟<input type="number" min="30" step="15" value={durationMinutes} onChange={(event) => { setDurationMinutes(Number(event.target.value)); setSubmitted(false); }} /></label>}
        <div className="staged-command"><strong>待提交命令</strong><code>{command}</code><small>baseVersionId: {versionId}</small></div>
        {submitted && <div className={`notice ${scenario === "failed" ? "error" : "info"}`} role="status" data-testid="edit-outcome"><strong>{command}</strong><br />{outcome[scenario]}</div>}
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit">提交演示命令</button></div>
      </form>
    </Modal>
  );
}

export function ItineraryWorkspace({ version, state, dispatch }: WorkspaceProps) {
  const [modal, setModal] = useState<"sources" | "warnings" | "credits" | "edit" | null>(null);
  const mapDays = useMemo(() => state.selection.dayIndex === 0 ? version.days : version.days.filter((day) => day.dayIndex === state.selection.dayIndex), [state.selection.dayIndex, version.days]);
  const scenarioNotice = state.scenario === "failed" || state.scenario === "cancelled" || state.scenario === "pending" ? state.scenario : null;

  function selectDay(dayIndex: number) {
    dispatch({ type: "select-day", dayIndex });
    if (state.viewMode !== "list") return;
    requestAnimationFrame(() => {
      const projection = document.querySelector<HTMLElement>(".projection");
      if (dayIndex === 0) {
        projection?.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      projection?.querySelector<HTMLElement>(`#day-${dayIndex}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <main className="workspace" data-testid="itinerary-workspace">
      <header className="workspace-header">
        <button className="icon-button" type="button" onClick={() => dispatch({ type: "return-library" })} aria-label="返回行程库" title="返回行程库" data-testid="back-to-library"><ArrowLeft aria-hidden="true" size={19} /></button>
        <div className="workspace-title"><span className="fixture-badge">界面演示</span><h1>{version.title}</h1><p>{version.destination} · {version.dayCount} 天 · 版本 {version.briefRevision}</p></div>
        <div className="workspace-actions">
          <button className="secondary-button compact" type="button" onClick={() => setModal("sources")}><BookOpen aria-hidden="true" size={16} />资料</button>
          <button className="secondary-button compact" type="button" onClick={() => setModal("warnings")}><AlertTriangle aria-hidden="true" size={16} />提醒</button>
          {!state.conversationOpen && <button className="icon-button" type="button" onClick={() => dispatch({ type: "toggle-conversation" })} aria-label="打开规划对话" title="规划对话" data-testid="open-conversation"><MessageSquareText aria-hidden="true" size={19} /></button>}
        </div>
      </header>

      <div className="workspace-nav">
        <div className="day-tabs" role="tablist" aria-label="选择行程日期">
          <button role="tab" aria-selected={state.selection.dayIndex === 0} onClick={() => selectDay(0)} data-testid="day-tab-0">总览</button>
          {version.days.map((day) => <button role="tab" aria-selected={state.selection.dayIndex === day.dayIndex} onClick={() => selectDay(day.dayIndex)} key={day.id} data-testid={`day-tab-${day.dayIndex}`}>第 {day.dayIndex} 天</button>)}
        </div>
        <div className="segmented" aria-label="查看方式">
          <button type="button" aria-pressed={state.viewMode === "list"} onClick={() => dispatch({ type: "set-view", viewMode: "list" })} data-testid="view-list"><List aria-hidden="true" size={16} />列表</button>
          <button type="button" aria-pressed={state.viewMode === "map"} onClick={() => dispatch({ type: "set-view", viewMode: "map" })} data-testid="view-map"><MapIcon aria-hidden="true" size={16} />地图</button>
        </div>
      </div>

      {scenarioNotice && <div className={`notice workspace-notice ${state.scenario === "failed" ? "error" : "info"}`} role="status">{state.scenario === "pending" ? "修改等待中；当前仍为版本 1。" : state.scenario === "failed" ? "修改被拒绝；版本 1 已保留。" : "修改已取消；版本 1 已保留。"}</div>}

      <div className={`workspace-grid ${state.conversationOpen ? "with-conversation" : ""} ${state.selection.visitId || state.selection.legId ? "has-detail" : ""}`}>
        <section className="projection" aria-label={state.viewMode === "list" ? "行程列表" : "地图视图"}>
          {state.viewMode === "list" ? <Timeline version={version} days={version.days} state={state} dispatch={dispatch} /> : <MapShell version={version} days={mapDays} state={state} dispatch={dispatch} />}
        </section>
        <SelectionDetail version={version} state={state} dispatch={dispatch} onEdit={() => setModal("edit")} />
        {state.conversationOpen && <ConversationPanel scenario={state.scenario} onClose={() => dispatch({ type: "toggle-conversation" })} />}
      </div>

      {modal === "sources" && <Modal title="资料与依据" description="本阶段未连接外部检索，以下均为夹具说明。" onClose={() => setModal(null)} testId="sources-dialog"><div className="source-list">{version.evidence.map((item) => <article key={item.id}><span className="fixture-badge">{item.status === "fixture" ? "演示资料" : item.status}</span><h3>{item.title}</h3><p>{item.excerpt}</p></article>)}</div><button className="text-button" type="button" onClick={() => setModal("credits")}>查看图片来源</button></Modal>}
      {modal === "warnings" && <Modal title="假设与提醒" onClose={() => setModal(null)} testId="warnings-dialog"><section className="warning-section"><h3>假设</h3>{version.assumptions.map((item) => <p key={item}><Info aria-hidden="true" size={15} />{item}</p>)}<h3>提醒</h3>{version.warnings.map((item) => <p key={item}><AlertTriangle aria-hidden="true" size={15} />{item}</p>)}</section></Modal>}
      {modal === "credits" && <PhotoCredits onClose={() => setModal(null)} />}
      {modal === "edit" && state.selection.visitId && <EditModal scenario={state.scenario} visitId={state.selection.visitId} versionId={version.id} onClose={() => setModal(null)} />}
    </main>
  );
}
