import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import CartelaPage from './pages/CartelaPage.jsx'
import GamePage from './pages/GamePage.jsx'

export default function App() {
  // Redirect / to /cartela
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/cartela" replace />} />
        <Route path="/cartela" element={<CartelaPage />} />
        <Route path="/game" element={<GamePage />} />
        <Route path="*" element={<Navigate to="/cartela" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
