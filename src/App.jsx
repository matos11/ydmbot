import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import SplashPage from './pages/SplashPage.jsx'
import CartelaPage from './pages/CartelaPage.jsx'
import GamePage from './pages/GamePage.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SplashPage />} />
        <Route path="/cartela" element={<CartelaPage />} />
        <Route path="/game" element={<GamePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}