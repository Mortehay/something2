import styled from "styled-components";

// Shared look of the sign-in card and its sibling account screens.
export const Screen = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  width: 100%;
  background-color: #0f0f1a;
`;

export const Card = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 320px;
  padding: 2rem;
  background: #1a1a2e;
  border: 2px solid #2e2e3e;
  border-radius: 12px;
`;

export const Title = styled.h1`
  color: white;
  margin: 0;
  font-size: 1.6rem;
  text-align: center;
`;

export const Field = styled.input`
  padding: 0.75rem 1rem;
  font-size: 1rem;
  border-radius: 8px;
  border: 1px solid #2e2e3e;
  background: #0f0f1a;
  color: white;

  &:focus {
    outline: none;
    border-color: #4a9eff;
  }
`;

export const Submit = styled.button`
  padding: 0.8rem 1rem;
  font-size: 1rem;
  font-weight: bold;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  background: #4a9eff;
  color: white;

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
`;

export const Toggle = styled.button`
  background: none;
  border: none;
  color: #4a9eff;
  cursor: pointer;
  font-size: 0.9rem;
`;

export const ErrorText = styled.p`
  color: #f87171;
  margin: 0;
  font-size: 0.9rem;
  text-align: center;
`;

// Neutral and positive messages, using the existing body and accent colours.
export const Notice = styled.p`
  color: #b8b8c8;
  margin: 0;
  font-size: 0.9rem;
  text-align: center;
  line-height: 1.4;
`;

export const OkText = styled(Notice)`
  color: #4a9eff;
`;

export const Hint = styled.textarea`
  padding: 0.75rem 1rem;
  font-size: 1rem;
  font-family: inherit;
  border-radius: 8px;
  border: 1px solid #2e2e3e;
  background: #0f0f1a;
  color: white;
  resize: vertical;
  min-height: 4rem;

  &:focus {
    outline: none;
    border-color: #4a9eff;
  }
`;
