/** A rectangle expressed as fractions (0..1) of the page width/height. */
export type Box = { x: number; y: number; w: number; h: number };

/** One thing the pointer visits while the narration is playing. */
export type Callout = {
  /** Short on-screen label, e.g. "Grade beam GB-2" */
  label: string;
  /** Where on the page (fractions of page size). */
  box: Box;
  /**
   * A short phrase copied verbatim from `narration`. The pointer moves to this
   * callout when the narration reaches that phrase.
   */
  cue: string;
};

export type Segment = {
  id: string;
  /** Section heading shown on screen, e.g. "3. Structural system" */
  title: string;
  /** 0-based page index this segment is filmed on. */
  page: number;
  /** Camera target on that page (fractions). Use the whole page for overviews. */
  focus: Box;
  /** Plain-English narration, spoken by TTS. */
  narration: string;
  callouts: Callout[];
  /** Optional 1-3 takeaways shown on a recap card after this segment (end of a discipline). */
  recap?: string[];
  /** Heading for the recap card, e.g. "Existing conditions"; defaults to "Recap". */
  recapTitle?: string;
};

export type Brief = {
  projectName: string;
  documentType: "RFP" | "RFQ" | "Plans" | "Specs" | "Mixed" | "Other";
  oneLiner: string;
  /** Top-down table of contents of the video. */
  segments: Segment[];
  /** Short, scannable summary that ships alongside the video. */
  summary: {
    scope: string[];
    keyDates: string[];
    requirements: string[];
    risks: string[];
    questionsToAsk: string[];
  };
};

export type JobStatus =
  | "queued"
  | "ingesting"
  | "analyzing"
  | "needs_script"
  | "verifying"
  | "narrating"
  | "rendering"
  | "done"
  | "error";

export type Job = {
  id: string;
  createdAt: string;
  updatedAt: string;
  originalName: string;
  status: JobStatus;
  progress: number; // 0..100
  message: string;
  pageCount?: number;
  brief?: Brief;
  /** manual mode: the prompt the person pastes into Claude */
  prompt?: string;
  /** triple-verification report (see review.ts) */
  verification?: import("./review").VerificationReport;
  videoUrl?: string;
  durationSec?: number;
  /** start time (seconds) of each segment in the video */
  segmentStarts?: number[];
  error?: string;
};
