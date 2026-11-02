import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useComposerVoiceInput } from "./useComposerVoiceInput";

const preventFocusSteal = (event: { preventDefault: () => void }) => event.preventDefault();

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function RecordingElapsed({ startedAt }: { readonly startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the recording clock once a second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {formatElapsed(Math.max(0, Math.floor((now - startedAt) / 1000)))}
    </span>
  );
}

export function ComposerVoiceInputControl({
  voice,
  shortcutLabel,
}: {
  readonly voice: ReturnType<typeof useComposerVoiceInput>;
  readonly shortcutLabel: string | null;
}) {
  const { phase } = voice.state;

  if (phase === "recording" || phase === "transcribing" || phase === "preparing") {
    return (
      <div className="flex shrink-0 items-center gap-1" data-chat-composer-voice-input={phase}>
        {phase === "recording" ? (
          <>
            <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
            {voice.recordingStartedAt !== null ? (
              <RecordingElapsed startedAt={voice.recordingStartedAt} />
            ) : null}
          </>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner size="sm" aria-hidden="true" />
            {phase === "transcribing" ? "Transcribing" : null}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onPointerDown={preventFocusSteal}
          onClick={voice.cancel}
          aria-label="Cancel voice input"
        >
          <XIcon />
        </Button>
        {phase === "recording" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onPointerDown={preventFocusSteal}
                  onClick={voice.stop}
                  aria-label="Finish recording and transcribe"
                />
              }
            >
              <CheckIcon />
            </TooltipTrigger>
            <TooltipPopup>Transcribe{shortcutLabel ? ` (${shortcutLabel})` : ""}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={preventFocusSteal}
            onClick={voice.toggle}
            aria-label="Voice input"
          />
        }
      >
        <MicIcon />
      </TooltipTrigger>
      <TooltipPopup>Voice input{shortcutLabel ? ` (${shortcutLabel})` : ""}</TooltipPopup>
    </Tooltip>
  );
}
