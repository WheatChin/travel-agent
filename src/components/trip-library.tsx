"use client";

import type { ItineraryVersion } from "@/domain/contracts";
import { CalendarDays, Map, Plus, Search } from "lucide-react";
import { useState } from "react";
import type { FixtureScenario } from "@/presentation/state";
import { Modal } from "./modal";
import { PlaceImage } from "./place-image";

type TripLibraryProps = {
  version: ItineraryVersion;
  scenario: FixtureScenario;
  onOpenTrip: () => void;
  onOpenMap: () => void;
};

export function TripLibrary({ version, scenario, onOpenTrip, onOpenMap }: TripLibraryProps) {
  const [dialog, setDialog] = useState<"create" | "date" | null>(null);
  const [dateInput, setDateInput] = useState("");
  const [stagedDate, setStagedDate] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const cover = version.places[0];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const matchesQuery = `${version.title} ${version.destination}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
  const visibleCount = scenario === "empty" || !matchesQuery ? 0 : 1;

  function submitUnavailable(label: string) {
    setDialog(null);
    setNotice(`${label}已记录为演示输入；后端尚未连接，未创建或修改 Trip。`);
  }

  return (
    <main className="library" data-testid="trip-library">
      <header className="library-header">
        <div>
          <p className="eyebrow">TRIP LIBRARY</p>
          <h1>我的行程</h1>
          <p>整理旅行想法与当前行程版本</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setDialog("create")} data-testid="create-trip-button">
          <Plus aria-hidden="true" size={18} /> 创建行程
        </button>
      </header>

      <div className="library-toolbar">
        <label className="search-box">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">搜索行程</span>
          <input type="search" placeholder="搜索目的地或行程" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <span>{visibleCount} 个演示行程</span>
      </div>

      {notice && <div className="notice info" role="status">{notice}</div>}

      {visibleCount === 0 ? (
        <section className="empty-state" data-testid="empty-library">
          <CalendarDays aria-hidden="true" size={30} />
          <h2>{query ? "没有匹配的行程" : "还没有行程"}</h2>
          <p>{query ? "换一个目的地或行程名称试试。" : "当前是空列表演示状态。"}</p>
          <button className="secondary-button" type="button" onClick={() => setDialog("create")}>创建行程</button>
        </section>
      ) : (
        <section className="trip-grid" aria-label="行程列表">
          <article className="trip-card">
            <button className="trip-cover-button" type="button" onClick={onOpenTrip} aria-label={`打开${version.title}`} data-testid="open-beijing-trip">
              <PlaceImage src={cover.imageSrc} alt={cover.imageAlt} forceFailure={scenario === "image-failure"} className="trip-cover" />
            </button>
            <div className="trip-card-body">
              <div className="trip-card-heading">
                <div>
                  <span className="fixture-badge">界面演示</span>
                  <h2>{version.title}</h2>
                </div>
                <button className="icon-button" type="button" onClick={onOpenMap} aria-label="打开地图视图" title="打开地图" data-testid="open-beijing-map">
                  <Map aria-hidden="true" size={19} />
                </button>
              </div>
              <p>{version.destination} · {version.dayCount} 天 · 版本 1</p>
              <div className="trip-card-footer">
                <div><span>{version.dateStart || "未设置出行日期"}</span>{stagedDate && <small className="pending-date">待提交演示：{stagedDate}</small>}</div>
                <button className="text-button" type="button" onClick={() => { setDateInput(""); setDialog("date"); }} data-testid="edit-date-button">编辑日期</button>
              </div>
            </div>
          </article>
        </section>
      )}

      {dialog === "create" && (
        <Modal title="创建行程" description="填写内容仅用于演示表单，不会调用模型或创建真实行程。" onClose={() => setDialog(null)} testId="create-trip-dialog">
          <form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitUnavailable("行程信息"); }}>
            <label>目的地<input required name="destination" defaultValue="北京" /></label>
            <label>旅行天数<input required name="days" type="number" min="1" max="7" defaultValue="3" /></label>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setDialog(null)}>取消</button><button className="primary-button" type="submit">记录演示输入</button></div>
          </form>
        </Modal>
      )}
      {dialog === "date" && (
        <Modal title="设置出行日期" description="日期修改不会写入当前不可变版本。" onClose={() => { setDateInput(""); setDialog(null); }} testId="date-dialog">
          <form className="form-stack" onSubmit={(event) => { event.preventDefault(); setStagedDate(dateInput); submitUnavailable("日期"); }}>
            <label>开始日期<input required type="date" value={dateInput} onChange={(event) => setDateInput(event.target.value)} /></label>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => { setDateInput(""); setDialog(null); }}>取消</button><button className="primary-button" type="submit">暂存日期</button></div>
          </form>
        </Modal>
      )}
    </main>
  );
}
