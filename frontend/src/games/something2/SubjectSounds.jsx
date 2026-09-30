// The Sounds section for one subject, reused in three places (SOMET-591,
// game audio slice 2, Task 7): AudioAdmin.jsx's own subject view, and now
// also embedded directly in MapsAdmin.jsx's MapCard (kind="world") and
// BiomesAdmin.jsx's BiomeCard (kind="biome") -- an admin can bind a
// world/biome's music or ambience right where they already edit that
// subject, instead of hunting for it again in the Audio tab.
//
// Upload/library/bind/remove/volume/weight all work with no provider
// configured at all, and AudioSlotCard disables only its Suggest/Generate
// buttons via `canGenerate` (SOMET-591) -- it never hides itself behind a
// missing provider, which is exactly the state AudioAdmin's own former "no
// provider" early-return used to hide the whole tab behind.
//
// AudioAdmin passes `canGenerate` down explicitly (it already derives it
// once from useAiProviders() for its own banner). MapsAdmin/BiomesAdmin embed
// this component directly with no such prop, so when it's omitted this
// derives the same value itself from useAiProviders() -- same rule, same
// query cache entry, so the world/biome editors disable Suggest/Generate in
// lockstep with the Audio tab rather than drifting from it. Loading defaults
// to enabled (see audioProviderState) so a slow fetch doesn't flash the
// buttons disabled for a moment on first mount.
//
// It also must not throw while useAudioSubjects() is loading or errored --
// those two pages render this unconditionally once a world/biome exists, so
// a slow or failed subjects fetch cannot take the whole editor card down
// with it.
import styled from 'styled-components';
import { useAudioSubjects, useSubjectSlots, usePrompts } from './useAudioAdmin.js';
import { subjectSlotsFor } from './audioBatch.js';
import { useAudioPreview } from './useAudioPreview.js';
import { useAiProviders, audioProviderState } from './useAiProviders.js';
import AdminLoading from './AdminLoading.jsx';
import AudioSlotCard from './AudioSlotCard.jsx';

const Wrap = styled.div`margin-top: 0.5rem;`;
const Heading = styled.h4`
  margin: 0 0 0.5rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--s2-text-muted);
`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0.25rem 0;`;

// `compact` trims the section to what fits inside a dense form card
// (MapCard/BiomeCard already carry many rows of their own): a smaller
// "Sounds" heading in place of AudioAdmin's own subject-name header, which
// the Audio tab prints itself and does not want duplicated.
function SubjectSounds({
  kind, subjectKey, compact = false, canGenerate: canGenerateProp,
}) {
  const { subjects, isLoadingSubjects, subjectsError } = useAudioSubjects();
  const { slots: bindings, isLoadingSlots } = useSubjectSlots(kind, subjectKey);
  // One request per subject (Task 12), not one per card: every AudioSlotCard
  // below reads its own slot out of this single `prompts` map.
  const { prompts } = usePrompts(kind, subjectKey);
  const { activeAudioProvider, isLoadingProviders, providersError } = useAiProviders();
  const canGenerate = canGenerateProp === undefined
    ? audioProviderState({
      activeAudioProvider, isLoading: isLoadingProviders, error: providersError,
    }).canGenerate
    : canGenerateProp;
  // Its own preview instance, not a prop from the caller: MapCard and
  // BiomeCard have no audio playback state of their own to lend it, and
  // AudioAdmin's own Subjects/Library tabs are mutually exclusive (only one
  // ever renders), so a separate instance here still keeps "one clip plays
  // at a time" true for whichever cards are actually on screen at once.
  const preview = useAudioPreview();

  if (subjectsError) return <Err>{String(subjectsError.message)}</Err>;

  const slots = subjectSlotsFor(subjects, kind);
  const subject = { kind, key: subjectKey };
  // The registry's per-subject cue map (game audio slice 3): undefined for a
  // kind with no `cues` at all (world, biome), which AudioSlotCard reads the
  // same way as "not sfx, ignore this prop".
  const group = (subjects || []).find((g) => g.kind === kind);
  const cues = (group && group.cues && group.cues[subjectKey]) || {};

  return (
    <Wrap>
      {compact && <Heading>Sounds</Heading>}
      {(isLoadingSubjects || isLoadingSlots) && <AdminLoading label="Loading clips…" inline size={16} />}
      {!isLoadingSubjects && slots.length === 0 && <Hint>No sound slots for this subject.</Hint>}
      {slots.map((s) => (
        <AudioSlotCard
          // Keyed by subject too, not just slot: every world has the same
          // slot names as every other world (music, ambience), so a
          // slot-only key would let React reuse a mounted card across a
          // subject switch -- carrying over its draft prompt and (before the
          // mutationKey fix in useAudioAdmin.js) letting a pending
          // generation for one subject read as pending for whichever
          // subject the card next rendered.
          key={`${kind}/${subjectKey}/${s.slot}`}
          subject={subject}
          slot={s.slot}
          clipKind={s.clipKind}
          rows={bindings[s.slot] || []}
          playingId={preview.playingId}
          onPlay={preview.play}
          onStop={preview.stop}
          canGenerate={canGenerate}
          cue={cues[s.slot]}
          prompt={prompts[s.slot]}
        />
      ))}
    </Wrap>
  );
}

export default SubjectSounds;
