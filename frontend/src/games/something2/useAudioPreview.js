// A single shared <audio> across whatever owns this hook instance: only one
// preview plays at a time among all the cards/rows that instance's
// playingId/play/stop get passed down to. Recreated per play rather than
// reused, so a new src always starts clean.
//
// Moved out of AudioAdmin.jsx (SOMET-590/591) into its own file for Task 7
// (game audio slice 2): SubjectSounds.jsx, embedded in the world and biome
// editors, needs the exact same one-preview-at-a-time behaviour for its own
// slot cards, independent of whatever AudioAdmin's Library tab is doing with
// its own instance.
import { useCallback, useEffect, useRef, useState } from 'react';

export function useAudioPreview() {
  const audioRef = useRef(null);
  const [playingId, setPlayingId] = useState(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setPlayingId(null);
  }, []);

  const play = useCallback((id, url) => {
    stop();
    const audio = new Audio(url);
    audio.addEventListener('ended', () => setPlayingId((cur) => (cur === id ? null : cur)));
    audio.play().catch(() => {});
    audioRef.current = audio;
    setPlayingId(id);
  }, [stop]);

  useEffect(() => () => { if (audioRef.current) audioRef.current.pause(); }, []);

  return { playingId, play, stop };
}

export default useAudioPreview;
