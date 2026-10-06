// frontend/test/login.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Login from '../src/components/Login.jsx';

afterEach(() => vi.unstubAllGlobals());

describe('Login', () => {
  it('valida contra /status y entra', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} apiUrl="/api" />);
    await userEvent.type(screen.getByPlaceholderText(/contraseña/i), 'pw');
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('pw'));
    expect(fetchMock).toHaveBeenCalledWith('/api/status', { headers: { Authorization: 'Bearer pw' } });
  });
  it('contraseña incorrecta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false }));
    render(<Login onLogin={vi.fn()} apiUrl="/api" />);
    await userEvent.type(screen.getByPlaceholderText(/contraseña/i), 'mal');
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }));
    expect(await screen.findByText(/contraseña incorrecta/i)).toBeInTheDocument();
  });
});
