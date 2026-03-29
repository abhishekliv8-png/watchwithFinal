const GENRE_MAP = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi",
  10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western"
};

const SERVICE_TO_TMDB = {
  netflix: ["Netflix", "Netflix basic with Ads"],
  amazon: ["Amazon Prime Video", "Amazon Video"],
  disney: ["Disney Plus", "Disney+"],
  hbo: ["Max", "HBO Max", "Max Amazon Channel"],
  hulu: ["Hulu"],
  apple: ["Apple TV Plus", "Apple TV+"],
  peacock: ["Peacock", "Peacock Premium"],
  paramount: ["Paramount Plus", "Paramount+", "Paramount Plus Apple TV Channel"],
  crunchyroll: ["Crunchyroll"]
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { participants } = req.body;
  const TMDB_API_KEY = process.env.TMDB_API_KEY || "a7d8da4c2aff8a41d4fffe15f1161fc5";

  if (!participants || !Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: "Invalid participants data" });
  }

  try {
    const genreCounts = {};
    participants.forEach(p => {
      (p.genres || []).forEach(gId => {
        genreCounts[gId] = (genreCounts[gId] || 0) + 1;
      });
    });

    let topGenreIds = Object.keys(genreCounts).map(Number).filter(id => genreCounts[id] >= 2);
    if (topGenreIds.length === 0) {
      topGenreIds = Object.keys(genreCounts).map(Number);
    }

    const serviceCounts = {};
    participants.forEach(p => {
      (p.services || []).forEach(sId => {
        serviceCounts[sId] = (serviceCounts[sId] || 0) + 1;
      });
    });

    const groupTmdbNames = new Set();
    Object.keys(serviceCounts).forEach(sId => {
      (SERVICE_TO_TMDB[sId] || []).forEach(name => groupTmdbNames.add(name.toLowerCase()));
    });

    const sharedServiceIds = Object.keys(serviceCounts).filter(
      sId => serviceCounts[sId] === participants.length
    );
    const sharedTmdbNames = new Set();
    sharedServiceIds.forEach(sId => {
      (SERVICE_TO_TMDB[sId] || []).forEach(name => sharedTmdbNames.add(name.toLowerCase()));
    });

    const fetchMovies = async (page) => {
      let url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&vote_average.gte=6.0&vote_count.gte=100&sort_by=popularity.desc&page=${page}&watch_region=US&with_original_language=en`;
      if (topGenreIds.length > 0) url += `&with_genres=${topGenreIds.join(",")}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`TMDB API returned ${response.status}`);
      return response.json();
    };

    const randomPages = [];
    while (randomPages.length < 3) {
      const p = Math.floor(Math.random() * 10) + 1;
      if (!randomPages.includes(p)) randomPages.push(p);
    }

    const pages = await Promise.all(randomPages.map(p => fetchMovies(p)));
    let candidateMovies = pages.flatMap(p => p.results || []);
    const seen = new Set();
    candidateMovies = candidateMovies.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });

    if (candidateMovies.length === 0) {
      const popRes = await fetch(`https://api.themoviedb.org/3/movie/popular?api_key=${TMDB_API_KEY}&page=1`);
      const popData = await popRes.json();
      return res.json({ results: (popData.results || []).slice(0, 5).map(m => ({
        id: m.id, title: m.title, poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`,
        rating: m.vote_average, year: m.release_date ? m.release_date.substring(0, 4) : "N/A",
        overview: m.overview, matchScore: 75, genre_ids: m.genre_ids, availableOn: []
      }))});
    }

    const scoredMovies = candidateMovies.map(movie => {
      const movieGenres = movie.genre_ids || [];
      const matchedGenres = movieGenres.filter(id => topGenreIds.includes(id));
      const genreScore = topGenreIds.length > 0 ? Math.min(matchedGenres.length / topGenreIds.length, 1.0) : 0;
      const ratingScore = (movie.vote_average || 0) / 10;
      const popularityScore = Math.min((movie.popularity || 0) / 200, 1.0);
      const releaseYear = movie.release_date ? parseInt(movie.release_date.substring(0, 4)) : 0;
      const recencyBonus = releaseYear >= 2022 ? 0.1 : 0;
      const totalScore = (genreScore * 0.45) + (ratingScore * 0.30) + (popularityScore * 0.15) + recencyBonus;
      return { ...movie, totalScore, year: movie.release_date ? movie.release_date.substring(0, 4) : "N/A" };
    });

   const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const notInTheaters = scoredMovies.filter(m => {
      if (!m.release_date) return true;
      return new Date(m.release_date) < sixtyDaysAgo;
    });
    const moviesToCheck = notInTheaters.length > 10 ? notInTheaters : scoredMovies;
    const top30 = moviesToCheck.sort((a, b) => b.totalScore - a.totalScore).slice(0, 30);

    const resultsWithAvailability = await Promise.all(top30.map(async (m) => {
      let availableOn = [];
      let availableOnGroupServices = [];
      try {
        const providerRes = await fetch(`https://api.themoviedb.org/3/movie/${m.id}/watch/providers?api_key=${TMDB_API_KEY}`);
        const providerData = await providerRes.json();
        const usResults = providerData.results?.US || {};
        const providers = usResults.flatrate || [];
        availableOn = [...new Set(providers.map(p => p.provider_name))];
        availableOnGroupServices = availableOn.filter(name =>
          groupTmdbNames.has(name.toLowerCase())
        );
      } catch (e) { /* skip */ }

      const onSharedService = availableOn.some(name => sharedTmdbNames.has(name.toLowerCase()));
      const onAnyGroupService = availableOnGroupServices.length > 0;
      const serviceBonus = onSharedService ? 0.2 : (onAnyGroupService ? 0.1 : 0);
      const finalScore = m.totalScore + serviceBonus;

      return {
        id: m.id, title: m.title, poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`,
        rating: m.vote_average, year: m.year, overview: m.overview,
        matchScore: Math.round(finalScore * 100),
        genreTags: (m.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean),
        availableOn: availableOnGroupServices.length > 0 ? availableOnGroupServices : availableOn,
        onGroupService: onAnyGroupService,
        genre_ids: m.genre_ids
      };
    }));

    const onGroupServices = resultsWithAvailability.filter(m => m.onGroupService);
    const others = resultsWithAvailability.filter(m => !m.onGroupService && m.availableOn.length > 0);

    let finalResults;
    if (onGroupServices.length >= 5) {
      const top15 = onGroupServices.sort((a, b) => b.matchScore - a.matchScore).slice(0, 15);
      finalResults = top15.sort(() => Math.random() - 0.5).slice(0, 8);
    } else if (onGroupServices.length > 0) {
      const remaining = 8 - onGroupServices.length;
      const fillers = others.sort((a, b) => b.matchScore - a.matchScore).slice(0, remaining);
      finalResults = [...onGroupServices, ...fillers];
    } else {
      const available = resultsWithAvailability.filter(m => m.availableOn.length > 0);
      if (available.length > 0) {
        finalResults = available.sort(() => Math.random() - 0.5).slice(0, 8);
      } else {
        finalResults = resultsWithAvailability
          .sort((a, b) => b.matchScore - a.matchScore)
          .slice(0, 8)
          .map(m => ({ ...m, availableOn: ["Check streaming apps"] }));
      }
    }

    return res.json({ results: finalResults });
  } catch (error) {
    console.error("Recommendation error:", error);
    return res.status(500).json({ error: "Failed to generate recommendations" });
  }
}
