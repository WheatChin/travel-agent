import {
  itineraryVersionSchema,
  type ItineraryVersion,
} from "../domain/contracts";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
}

const fixtureData = {
  id: "version_beijing-3day-v1",
  tripId: "trip_beijing-cultural",
  conversationId: "conversation_beijing-cultural",
  title: "北京三日文化之旅",
  destination: "北京",
  dateStart: null,
  dayCount: 3,
  briefRevision: 1,
  provenance: "fixture",
  days: [
    {
      id: "day_beijing-1",
      dayIndex: 1,
      title: "皇城中轴",
      summary: "从故宫到景山，以示例时间体验北京皇城空间。",
      visits: [
        {
          id: "visit_forbidden-city",
          placeId: "place_forbidden-city",
          startTime: "09:00",
          endTime: "12:00",
          durationMinutes: 180,
          locked: true,
          evidenceIds: ["evidence_forbidden-city-fixture"],
        },
        {
          id: "visit_jingshan-park",
          placeId: "place_jingshan-park",
          startTime: "14:00",
          endTime: "15:30",
          durationMinutes: 90,
          locked: false,
          evidenceIds: ["evidence_jingshan-park-fixture"],
        },
      ],
      legs: [
        {
          id: "leg_forbidden-city-to-jingshan",
          fromVisitId: "visit_forbidden-city",
          toVisitId: "visit_jingshan-park",
          mode: "walk",
          durationMinutes: null,
          distanceMeters: null,
          geometry: null,
          provenance: "fixture",
        },
      ],
    },
    {
      id: "day_beijing-2",
      dayIndex: 2,
      title: "坛庙与老城",
      summary: "以天坛、前门为主的示例日程，不代表实时开放信息。",
      visits: [
        {
          id: "visit_temple-of-heaven",
          placeId: "place_temple-of-heaven",
          startTime: "09:00",
          endTime: "11:30",
          durationMinutes: 150,
          locked: false,
          evidenceIds: ["evidence_temple-of-heaven-fixture"],
        },
        {
          id: "visit_qianmen-street",
          placeId: "place_qianmen-street",
          startTime: "14:00",
          endTime: "16:00",
          durationMinutes: 120,
          locked: false,
          evidenceIds: ["evidence_qianmen-street-fixture"],
        },
      ],
      legs: [
        {
          id: "leg_temple-of-heaven-to-qianmen",
          fromVisitId: "visit_temple-of-heaven",
          toVisitId: "visit_qianmen-street",
          mode: "public_transit",
          durationMinutes: null,
          distanceMeters: null,
          geometry: null,
          provenance: "fixture",
        },
      ],
    },
    {
      id: "day_beijing-3",
      dayIndex: 3,
      title: "园林与遗址",
      summary: "串联皇家园林与历史遗址的演示行程。",
      visits: [
        {
          id: "visit_summer-palace",
          placeId: "place_summer-palace",
          startTime: "09:00",
          endTime: "11:30",
          durationMinutes: 150,
          locked: false,
          evidenceIds: ["evidence_summer-palace-fixture"],
        },
        {
          id: "visit_old-summer-palace",
          placeId: "place_old-summer-palace",
          startTime: "13:30",
          endTime: "15:30",
          durationMinutes: 120,
          locked: false,
          evidenceIds: ["evidence_old-summer-palace-fixture"],
        },
      ],
      legs: [
        {
          id: "leg_summer-palace-to-old-summer-palace",
          fromVisitId: "visit_summer-palace",
          toVisitId: "visit_old-summer-palace",
          mode: "public_transit",
          durationMinutes: null,
          distanceMeters: null,
          geometry: null,
          provenance: "fixture",
        },
      ],
    },
  ],
  places: [
    {
      id: "place_forbidden-city",
      name: "故宫博物院",
      district: "东城区",
      description: "明清皇宫建筑群，本行程中的文化主题演示地点。",
      imageSrc: "/images/forbidden-city.jpg",
      imageAlt: "故宫博物院建筑",
      coordinates: null,
      provenance: "fixture",
    },
    {
      id: "place_jingshan-park",
      name: "景山公园",
      district: "西城区",
      description: "位于北京城中轴线上的城市公园。",
      imageSrc: "/images/jingshan-park.jpg",
      imageAlt: "景山公园景观",
      coordinates: null,
      provenance: "fixture",
    },
    {
      id: "place_temple-of-heaven",
      name: "天坛公园",
      district: "东城区",
      description: "以传统坛庙建筑为主题的演示地点。",
      imageSrc: "/images/temple-of-heaven.jpg",
      imageAlt: "天坛公园祈年殿",
      coordinates: null,
      provenance: "fixture",
    },
    {
      id: "place_qianmen-street",
      name: "前门大街",
      district: "东城区",
      description: "北京老城中轴线附近的历史街区。",
      imageSrc: "/images/qianmen-street.jpg",
      imageAlt: "前门大街街景",
      coordinates: null,
      provenance: "fixture",
    },
    {
      id: "place_summer-palace",
      name: "颐和园",
      district: "海淀区",
      description: "以皇家园林空间为主题的演示地点。",
      imageSrc: "/images/summer-palace.jpg",
      imageAlt: "颐和园园林景观",
      coordinates: null,
      provenance: "fixture",
    },
    {
      id: "place_old-summer-palace",
      name: "圆明园",
      district: "海淀区",
      description: "承载历史记忆的园林遗址。",
      imageSrc: "/images/old-summer-palace.jpg",
      imageAlt: "圆明园遗址景观",
      coordinates: null,
      provenance: "fixture",
    },
  ],
  evidence: [
    ["forbidden-city", "故宫博物院"],
    ["jingshan-park", "景山公园"],
    ["temple-of-heaven", "天坛公园"],
    ["qianmen-street", "前门大街"],
    ["summer-palace", "颐和园"],
    ["old-summer-palace", "圆明园"],
  ].map(([slug, name]) => ({
    id: `evidence_${slug}-fixture`,
    placeId: `place_${slug}`,
    title: `${name}演示资料`,
    url: null,
    retrievedAt: null,
    status: "fixture",
    excerpt: "仅用于 Phase 1 界面演示；未连接外部来源，开放时间与可用性尚未核验。",
  })),
  assumptions: [
    "未指定出行日期，当前为不含日期可用性验证的演示行程。",
    "示例采用均衡节奏与步行加公共交通偏好。",
    "行程从每天第一处景点开始，并在最后一处景点结束，不含酒店或机场接送。",
  ],
  warnings: [
    "所有时间均为界面演示数据，不代表开放时间或生产排程结果。",
    "路线距离、时长和几何信息尚未接入地图服务。",
  ],
} as const;

export const beijingFixture: ItineraryVersion = deepFreeze(
  itineraryVersionSchema.parse(fixtureData),
);
