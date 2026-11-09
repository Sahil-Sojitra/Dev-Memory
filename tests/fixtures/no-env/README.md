# Isolated test environment directory

Vitest/Vite envDir points here so tests never auto-load the repository .env.
Tests supply synthetic environment objects and never need local credentials.
