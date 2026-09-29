// The Sounds section for one subject, reused in three places (SOMET-591,
// game audio slice 2, Task 7): AudioAdmin.jsx's own subject view, and now
// also embedded directly in MapsAdmin.jsx's MapCard (kind="world") and
// BiomesAdmin.jsx's BiomeCard (kind="biome") -- an admin can bind a
// world/biome's music or ambience right where they already edit that
// subject, instead of hunting for it again in the Audio tab.
//
// Deliberately independent of the audio provider: Upload works with no
// provider configured at all, and AudioSlotCard's Suggest/Generate buttons
// already handle a missing provider themselves (they just fail with a
// toast). So this component never checks useAiProviders -- it must keep
// rendering slot cards on MapsAdmin/BiomesAdmin even when Audio has no
// active provider, which is exactly the state AudioAdmin's own "no
// provider" early-return would otherwise hide behind.
//
// It also must not throw while useAudioSubjects() is loading or errored --
// those two pages render this unconditionally once a world/biome exists, so
// a slow or failed subjects fetch cannot take the whole editor card down
// with it.
import styled from 'styled-components';
import { useAudioSubjects, useSubjectSlots } from './useAudioAdmin.js';
import { subjectSlotsFor } from './audioBatch.js';
import { useAudioPreview } from './useAudioPreview.js';
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
function SubjectSounds({ kind, subjectKey, compact = false }) {
  const { subjects, isLoadingSubjects, subjectsError } = useAudioSubjects();
  const { slots: bindings, isLoadingSlots } = useSubjectSlots(kind, subjectKey);
  // Its own preview instance, not a prop from the caller: MapCard and
  // BiomeCard have no audio playback state of their own to lend it, and
  // AudioAdmin's own Subjects/Library tabs are mutually exclusive (only one
  // ever renders), so a separate instance here still keeps "one clip plays
  // at a time" true for whichever cards are actually on screen at once.
  const preview = useAudioPreview();

  if (subjectsError) return <Err>{String(subjectsError.message)}</Err>;

  const slots = subjectSlotsFor(subjects, kind);
  const subject = { kind, key: subjectKey };

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
        />
      ))}
    </Wrap>
  );
}

export default SubjectSounds;
