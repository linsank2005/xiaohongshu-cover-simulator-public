export type TestStatus = "pending" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

export type TestMode = "grid" | "vertical";

export function isTestMode(value: unknown): value is TestMode {
  return value === "grid" || value === "vertical";
}

export const GRID_CARD_NAMES = ["A", "B", "C", "D"] as const;
export const VERTICAL_CARD_NAMES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export type CardName = typeof VERTICAL_CARD_NAMES[number];
export type ModelChoice = CardName | "NONE";

export type AgentProfile = {
  id: string;
  age: number;
  gender: "女性" | "男性";
  cityTier: "一线" | "新一线" | "二线" | "其他";
  occupation: string;
  occupationCluster: "学生" | "职场" | "专业服务" | "经营创业" | "内容创作" | "家庭与生活";
  lifeStage: string;
  familyStage: string;
  interests: string[];
  contentPreferences: string[];
  consumptionHabits: string[];
  usageFrequency: string;
  currentBrowseState: string;
  clickHabit: string;
  titleSensitivity: "低" | "中" | "中高" | "高" | "很高";
  titleReliance: number;
  visualReliance: number;
  readabilitySensitivity: number;
  realLifeScenePreference: number;
  humanPresencePreference: number;
  resultNumberSensitivity: number;
  adSkepticism: number;
  noveltySeeking: number;
  visualPreferences: string[];
  contentAvoidances: string[];
  personality: string;
  browsePurpose: string;
  triggers: string[];
  profileVersion: string;
  source: string;
};

export type ReferenceCover = {
  id: string;
  fileName: string;
  label: string;
  title: string;
  category: string;
  track: string;
  noteId: string;
  weight: number;
  source: string;
  license: string;
};

export type TestCandidate = {
  key: string;
  label: string;
  path: string;
};

export type CandidateStats = {
  key: string;
  label: string;
  selectedCount: number;
  totalTrials: number;
  validTrials: number;
  selectionRate: number;
  noneSelectedCount: number;
  noneRate: number;
};

export type StoredTest = {
  id: string;
  uploadedPath: string;
  candidates: TestCandidate[];
  createdAt: string | null;
  completedAt: string | null;
  randomSeed: string;
  testMode: TestMode;
  title: string;
  referenceIds: string[];
  status: TestStatus;
  selectedCount: number | null;
  totalTrials: number;
  validTrials: number;
  requestCount: number;
  simulatedClickRate: number | null;
  noneSelectedCount: number | null;
  model: string | null;
  promptVersion: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
};
