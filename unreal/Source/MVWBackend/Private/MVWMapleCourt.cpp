// NOT COMPILED YET against your engine version. See docs/MAPLE_COURT.md.
#include "MVWMapleCourt.h"

#include "Engine/World.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/Pawn.h"
#include "DrawDebugHelpers.h"
#include "InputCoreTypes.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogMapleCourt, Log, All);

namespace
{
	constexpr float WallThickness = 30.f;
	constexpr float WallHeight = 300.f;
	constexpr float DoorHeight = 240.f;
	constexpr double InteractRadius = 260.0;
	const TCHAR* GroceryJobId = TEXT("job_grocery_assistant");
	const TCHAR* GroceryShopId = TEXT("shop_corner_grocery");

	TSharedPtr<FJsonObject> NewBody() { return MakeShared<FJsonObject>(); }

	FString RandomDigits(int32 Count)
	{
		FString Out;
		for (int32 i = 0; i < Count; ++i) { Out.AppendChar(static_cast<TCHAR>(TEXT('0') + FMath::RandRange(0, 9))); }
		return Out;
	}
}

// =====================================================================================================================
// lifecycle
// =====================================================================================================================

bool UMVWMapleCourtSubsystem::ShouldCreateSubsystem(UObject* Outer) const
{
	const UWorld* World = Cast<UWorld>(Outer);
	// Game worlds only (PIE / standalone / dedicated server). The server needs the geometry too so collision matches.
	return World && World->IsGameWorld() && Super::ShouldCreateSubsystem(Outer);
}

TStatId UMVWMapleCourtSubsystem::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(UMVWMapleCourtSubsystem, STATGROUP_Tickables);
}

void UMVWMapleCourtSubsystem::OnWorldBeginPlay(UWorld& InWorld)
{
	Super::OnWorldBeginPlay(InWorld);
	BuildCourt();

	const ENetMode Mode = InWorld.GetNetMode();
	bBackendSession = (Mode == NM_Standalone || Mode == NM_ListenServer);
	if (bBackendSession)
	{
		StartSession(false);
	}
	else if (Mode == NM_Client)
	{
		Say(TEXT("Maple Court (client view): buying, renting and working need the server RPC layer, which is the next milestone."), FColor::Yellow);
	}
}

void UMVWMapleCourtSubsystem::Deinitialize()
{
	Labels.Reset();
	Teleported.Reset();
	Materials.Reset();
	Super::Deinitialize();
}

// =====================================================================================================================
// world building
// =====================================================================================================================

AStaticMeshActor* UMVWMapleCourtSubsystem::SpawnBox(const FVector& Center, const FVector& SizeCm, const FLinearColor& Color)
{
	UWorld* World = GetWorld();
	if (!World || !CubeMesh) { return nullptr; }

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(Center, FRotator::ZeroRotator, Params);
	if (!Actor) { return nullptr; }

	UStaticMeshComponent* Mesh = Actor->GetStaticMeshComponent();
	Mesh->SetMobility(EComponentMobility::Movable); // must be set before assigning a mesh at runtime
	Mesh->SetStaticMesh(CubeMesh);
	Actor->SetActorScale3D(SizeCm / 100.0); // the engine cube is 100 cm per side

	if (BaseMaterial)
	{
		UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(BaseMaterial, this);
		if (Mid)
		{
			Mid->SetVectorParameterValue(TEXT("Color"), Color);
			Mesh->SetMaterial(0, Mid);
			Materials.Add(Mid);
		}
	}
	return Actor;
}

void UMVWMapleCourtSubsystem::AddLabel(const FVector& Loc, const FString& Text, const FColor& Color)
{
	Labels.Add({ Loc, Text, Color });
}

void UMVWMapleCourtSubsystem::BuildRoomBox(const FVector& C, float SX, float SY, float H, bool bDoorOnPositiveY, float DoorW,
	const FLinearColor& WallColor, const FLinearColor& FloorColor, bool bWithDoorPanel)
{
	const float T = WallThickness;
	const float HalfX = SX * 0.5f, HalfY = SY * 0.5f;
	const float Zc = H * 0.5f;

	// floor tint
	SpawnBox(FVector(C.X, C.Y, 2.f), FVector(SX - 2 * T, SY - 2 * T, 4.f), FloorColor);

	// side walls and the wall opposite the door
	const float BackY = bDoorOnPositiveY ? (C.Y - HalfY + T * 0.5f) : (C.Y + HalfY - T * 0.5f);
	const float FrontY = bDoorOnPositiveY ? (C.Y + HalfY - T * 0.5f) : (C.Y - HalfY + T * 0.5f);
	SpawnBox(FVector(C.X, BackY, Zc), FVector(SX, T, H), WallColor);
	SpawnBox(FVector(C.X - HalfX + T * 0.5f, C.Y, Zc), FVector(T, SY - 2 * T, H), WallColor);
	SpawnBox(FVector(C.X + HalfX - T * 0.5f, C.Y, Zc), FVector(T, SY - 2 * T, H), WallColor);

	// front wall with a door-sized gap centred on C.X
	const float SegW = (SX - DoorW) * 0.5f;
	SpawnBox(FVector(C.X - DoorW * 0.5f - SegW * 0.5f, FrontY, Zc), FVector(SegW, T, H), WallColor);
	SpawnBox(FVector(C.X + DoorW * 0.5f + SegW * 0.5f, FrontY, Zc), FVector(SegW, T, H), WallColor);
	SpawnBox(FVector(C.X, FrontY, DoorHeight + (H - DoorHeight) * 0.5f), FVector(DoorW, T, H - DoorHeight), WallColor); // lintel

	if (bWithDoorPanel)
	{
		DoorPanel = SpawnBox(FVector(C.X, FrontY, DoorHeight * 0.5f), FVector(DoorW, T * 0.6f, DoorHeight), FLinearColor(0.35f, 0.18f, 0.08f));
	}
}

void UMVWMapleCourtSubsystem::BuildCourt()
{
	CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	BaseMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (!CubeMesh)
	{
		UE_LOG(LogMapleCourt, Error, TEXT("Could not load /Engine/BasicShapes/Cube; Maple Court cannot be built"));
		return;
	}
	const FVector O = Origin;

	// ground and road
	SpawnBox(O + FVector(0, 0, -25), FVector(6000, 5000, 50), FLinearColor(0.20f, 0.45f, 0.20f));
	SpawnBox(O + FVector(0, 0, 3), FVector(6000, 800, 6), FLinearColor(0.08f, 0.08f, 0.09f));

	// apartment building (west of the road, door faces the road at +Y)
	const FVector AptC = O + FVector(-600, -1500, 0);
	BuildRoomBox(AptC, 1400, 1000, WallHeight, /*door +Y*/ true, 160, FLinearColor(0.25f, 0.40f, 0.75f), FLinearColor(0.60f, 0.55f, 0.45f), /*door panel*/ true);
	SpawnBox(AptC + FVector(-400, -300, 30), FVector(200, 120, 60), FLinearColor(0.85f, 0.85f, 0.95f)); // bed
	SpawnBox(AptC + FVector(300, -250, 35), FVector(220, 90, 70), FLinearColor(0.50f, 0.20f, 0.20f));   // sofa
	DoorZoneLoc = AptC + FVector(0, 500 + 150, 0); // outside the door, on the road side
	AddLabel(AptC + FVector(0, 500, 380), TEXT("MAPLE COURT APARTMENTS"), FColor(120, 170, 255));

	// corner grocery (east of the road, open doorway faces the road at -Y)
	const FVector ShopC = O + FVector(800, 1500, 0);
	BuildRoomBox(ShopC, 1400, 1000, WallHeight, /*door -Y*/ false, 200, FLinearColor(0.85f, 0.50f, 0.15f), FLinearColor(0.80f, 0.78f, 0.70f), /*door panel*/ false);
	SpawnBox(ShopC + FVector(0, 200, 55), FVector(500, 80, 110), FLinearColor(0.55f, 0.35f, 0.15f));     // counter
	CounterZoneLoc = ShopC + FVector(0, 200 - 150, 0);
	SpawnBox(ShopC + FVector(450, 250, 50), FVector(150, 150, 100), FLinearColor(0.95f, 0.85f, 0.15f)); // work station crate
	WorkZoneLoc = ShopC + FVector(450, 250 - 150, 0);
	AddLabel(ShopC + FVector(0, -500, 380), TEXT("CORNER GROCERY"), FColor(255, 190, 90));
	AddLabel(ShopC + FVector(0, 200, 190), TEXT("COUNTER"), FColor(255, 220, 160));
	AddLabel(ShopC + FVector(450, 250, 160), TEXT("WORK STATION"), FColor(255, 240, 120));

	// street furniture
	for (int32 i = -2; i <= 2; ++i)
	{
		SpawnBox(O + FVector(i * 1000.f, -480.f, 175.f), FVector(15, 15, 350), FLinearColor(0.2f, 0.2f, 0.22f)); // lamp posts
	}
	AddLabel(O + FVector(-2300, 0, 260), TEXT("NEW MERIDIAN - Residential District"), FColor(180, 255, 180));
}

void UMVWMapleCourtSubsystem::SetDoorOpen(bool bOpen)
{
	bDoorOpen = bOpen;
	if (DoorPanel)
	{
		DoorPanel->SetActorHiddenInGame(bOpen);
		DoorPanel->SetActorEnableCollision(!bOpen);
	}
	if (const UWorld* World = GetWorld())
	{
		DoorCloseAt = World->GetTimeSeconds() + 8.0;
	}
}

// =====================================================================================================================
// per-frame
// =====================================================================================================================

void UMVWMapleCourtSubsystem::Tick(float DeltaTime)
{
	const UWorld* World = GetWorld();
	if (!World) { return; }

	if (World->GetNetMode() != NM_Client) { TeleportNewPawns(); }
	DrawLabels();

	if (bDoorOpen && World->GetTimeSeconds() > DoorCloseAt) { SetDoorOpen(false); }

	if (World->GetNetMode() == NM_DedicatedServer) { return; }
	UpdateInteraction();
	UpdateHud();
}

void UMVWMapleCourtSubsystem::TeleportNewPawns()
{
	UWorld* World = GetWorld();
	int32 Index = Teleported.Num();
	for (FConstPlayerControllerIterator It = World->GetPlayerControllerIterator(); It; ++It)
	{
		APlayerController* PC = It->Get();
		APawn* Pawn = PC ? PC->GetPawn() : nullptr;
		if (!Pawn || Teleported.Contains(Pawn)) { continue; }
		const FVector Spawn = Origin + FVector(-2300.0, (Index % 4) * 150.0 - 225.0, 120.0);
		Pawn->SetActorLocationAndRotation(Spawn, FRotator::ZeroRotator, false, nullptr, ETeleportType::TeleportPhysics);
		PC->SetControlRotation(FRotator::ZeroRotator);
		Teleported.Add(Pawn);
		++Index;
	}
}

void UMVWMapleCourtSubsystem::DrawLabels() const
{
	const UWorld* World = GetWorld();
	if (!World) { return; }
	for (const FLabel& L : Labels)
	{
		DrawDebugString(World, L.Loc, L.Text, nullptr, L.Color, 0.05f, true, 1.6f);
	}
}

UMVWMapleCourtSubsystem::EZone UMVWMapleCourtSubsystem::NearestZone(const FVector& P) const
{
	struct FZ { EZone Z; const FVector* Loc; };
	const FZ Zones[] = { { EZone::Door, &DoorZoneLoc }, { EZone::Counter, &CounterZoneLoc }, { EZone::Work, &WorkZoneLoc } };
	EZone Best = EZone::None;
	double BestDist = InteractRadius;
	for (const FZ& Z : Zones)
	{
		const double D = FVector::Dist2D(P, *Z.Loc);
		if (D < BestDist) { BestDist = D; Best = Z.Z; }
	}
	return Best;
}

FString UMVWMapleCourtSubsystem::PromptFor(EZone Zone) const
{
	switch (Zone)
	{
	case EZone::Door:
		if (!bSessionReady) { return TEXT("Connecting to the backend..."); }
		if (!TenantPropertyId.IsEmpty() && TenantPropertyId == DoorPropertyId) { return FString::Printf(TEXT("[E] Open the door to %s"), *DoorPropertyName); }
		if (!TenantPropertyId.IsEmpty()) { return TEXT("You already rent another home (one at a time)"); }
		if (DoorPropertyId.IsEmpty()) { return TEXT("No rooms are free right now"); }
		return FString::Printf(TEXT("[E] Rent %s for %lld MVC and enter"), *DoorPropertyName, DoorRent);
	case EZone::Counter:
		return bSessionReady ? TEXT("[E] Buy a Sandwich (25 MVC)     [R] Buy Water (8 MVC)") : TEXT("Connecting to the backend...");
	case EZone::Work:
		if (!bSessionReady) { return TEXT("Connecting to the backend..."); }
		if (ShiftId.IsEmpty()) { return TEXT("[E] Start a shift (Grocery Assistant, pays 250 MVC)"); }
		return FString::Printf(TEXT("[E] Do task %d of %d (each task needs ~20 s)"), ShiftDone + 1, ShiftRequired);
	default:
		return FString();
	}
}

void UMVWMapleCourtSubsystem::UpdateInteraction()
{
	UWorld* World = GetWorld();
	APlayerController* PC = World ? World->GetFirstPlayerController() : nullptr;
	APawn* Pawn = PC ? PC->GetPawn() : nullptr;
	if (!Pawn || !GEngine) { return; }

	const EZone Zone = NearestZone(Pawn->GetActorLocation());
	if (Zone == EZone::None) { return; }
	GEngine->AddOnScreenDebugMessage(7005, 0.2f, FColor::Cyan, PromptFor(Zone), true, FVector2D(1.6, 1.6));

	if (!bBackendSession || !bSessionReady || bBusy) { return; }
	const bool bE = PC->WasInputKeyJustPressed(EKeys::E);
	const bool bR = PC->WasInputKeyJustPressed(EKeys::R);
	if (Zone == EZone::Door && bE) { OnDoorUse(); }
	else if (Zone == EZone::Counter && bE) { OnBuy(TEXT("sandwich"), TEXT("Sandwich")); }
	else if (Zone == EZone::Counter && bR) { OnBuy(TEXT("bottled_water"), TEXT("Water")); }
	else if (Zone == EZone::Work && bE) { OnWorkUse(); }
}

void UMVWMapleCourtSubsystem::UpdateHud()
{
	if (!GEngine) { return; }
	const double Now = GetWorld()->GetTimeSeconds();
	if (bBackendSession)
	{
		if (!bSessionReady)
		{
			GEngine->AddOnScreenDebugMessage(7001, 0.2f, FColor::Yellow, TEXT("Connecting to the MVW backend (is 'npm run dev' running?)"), true, FVector2D(1.3, 1.3));
		}
		else
		{
			GEngine->AddOnScreenDebugMessage(7001, 0.2f, FColor::Green, FString::Printf(TEXT("%s    MVC: %lld"), *DisplayName, Balance), true, FVector2D(1.8, 1.8));
			GEngine->AddOnScreenDebugMessage(7002, 0.2f, FColor::White, FString::Printf(TEXT("Home: %s"), *HomeText), true, FVector2D(1.3, 1.3));
			GEngine->AddOnScreenDebugMessage(7003, 0.2f, FColor::White, FString::Printf(TEXT("Backpack: %s"), *BackpackText), true, FVector2D(1.3, 1.3));
			GEngine->AddOnScreenDebugMessage(7004, 0.2f, FColor::White, FString::Printf(TEXT("Job: %s"), *ShiftText), true, FVector2D(1.3, 1.3));
		}
	}
	if (!LastMessage.IsEmpty() && Now < LastMessageUntil)
	{
		GEngine->AddOnScreenDebugMessage(7006, 0.2f, LastColor, LastMessage, true, FVector2D(1.5, 1.5));
	}
}

void UMVWMapleCourtSubsystem::Say(const FString& Text, const FColor& Color)
{
	UE_LOG(LogMapleCourt, Log, TEXT("%s"), *Text);
	LastMessage = Text;
	LastColor = Color;
	LastMessageUntil = (GetWorld() ? GetWorld()->GetTimeSeconds() : 0.0) + 7.0;
}

// =====================================================================================================================
// backend plumbing
// =====================================================================================================================

UMVWBackendSubsystem* UMVWMapleCourtSubsystem::Backend() const
{
	const UWorld* World = GetWorld();
	UGameInstance* GI = World ? World->GetGameInstance() : nullptr;
	return GI ? GI->GetSubsystem<UMVWBackendSubsystem>() : nullptr;
}

FString UMVWMapleCourtSubsystem::CharPath(const FString& Suffix) const
{
	return FString::Printf(TEXT("/v1/game/characters/%s%s"), *CharacterId, *Suffix);
}

void UMVWMapleCourtSubsystem::Call(const FString& Verb, const FString& Path, TSharedPtr<FJsonObject> Body, bool bAsPlayer, TFunction<void(const FMVWBackendResult&)> Done)
{
	UMVWBackendSubsystem* B = Backend();
	if (!B)
	{
		FMVWBackendResult Failed;
		Done(Failed);
		return;
	}
	B->Request(Verb, Path, Body, bAsPlayer ? PlayerToken : FString(),
		FMVWBackendCallback::CreateWeakLambda(this, [Done](const FMVWBackendResult& R) { Done(R); }));
}

FString UMVWMapleCourtSubsystem::Friendly(const FMVWBackendResult& R)
{
	if (R.Status == 0) { return TEXT("Cannot reach the backend. Is 'npm run dev' running, and is MVW_SERVER_KEY set?"); }
	const FString Code = R.ErrorCode();
	FString Message;
	if (R.Json.IsValid()) { R.Json->TryGetStringField(TEXT("message"), Message); }
	if (Code == TEXT("insufficient_funds")) { return TEXT("Not enough MVC."); }
	if (Code == TEXT("out_of_stock")) { return TEXT("Sold out."); }
	if (Code == TEXT("property_unavailable")) { return TEXT("Someone else already rents that room."); }
	if (Code == TEXT("tenancy_limit")) { return TEXT("You already rent a home."); }
	if (Code == TEXT("shift_limit_reached")) { return TEXT("You have worked enough shifts for today."); }
	if (Code == TEXT("invalid_server_key")) { return TEXT("The server key is wrong. Start Unreal from the window where you ran 'set MVW_SERVER_KEY=...'."); }
	if (!Message.IsEmpty() && Message != Code) { return Message; }
	return Code;
}

bool UMVWMapleCourtSubsystem::LoadIdentity()
{
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *(FPaths::ProjectSavedDir() / TEXT("MVWDevIdentity.json")))) { return false; }
	TSharedPtr<FJsonObject> J;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), J) || !J.IsValid()) { return false; }
	J->TryGetStringField(TEXT("email"), Email);
	J->TryGetStringField(TEXT("password"), Password);
	return !Email.IsEmpty() && !Password.IsEmpty();
}

void UMVWMapleCourtSubsystem::SaveIdentity() const
{
	TSharedPtr<FJsonObject> J = NewBody();
	J->SetStringField(TEXT("email"), Email);
	J->SetStringField(TEXT("password"), Password);
	FString Out;
	FJsonSerializer::Serialize(J.ToSharedRef(), TJsonWriterFactory<>::Create(&Out));
	FFileHelper::SaveStringToFile(Out, *(FPaths::ProjectSavedDir() / TEXT("MVWDevIdentity.json")));
}

void UMVWMapleCourtSubsystem::StartSession(bool bFreshIdentity)
{
	bSessionReady = false;
	if (bFreshIdentity || !LoadIdentity())
	{
		// A throwaway development account; stored in <project>/Saved/MVWDevIdentity.json so progress persists between runs.
		Email = FString::Printf(TEXT("mvw-dev-%s@example.com"), *FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(12).ToLower());
		Password = FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT("-Aa1");
		SaveIdentity();
		DoRegisterThenLogin();
	}
	else
	{
		DoLogin();
	}
}

void UMVWMapleCourtSubsystem::DoRegisterThenLogin()
{
	TSharedPtr<FJsonObject> B = NewBody();
	B->SetStringField(TEXT("email"), Email);
	B->SetStringField(TEXT("password"), Password);
	Call(TEXT("POST"), TEXT("/v1/auth/register"), B, true, [this](const FMVWBackendResult& R)
	{
		if (R.Status == 0) { Say(Friendly(R), FColor::Red); return; }
		DoLogin(); // 201 created, or 409 already exists: either way try to log in
	});
}

void UMVWMapleCourtSubsystem::DoLogin()
{
	TSharedPtr<FJsonObject> B = NewBody();
	B->SetStringField(TEXT("email"), Email);
	B->SetStringField(TEXT("password"), Password);
	Call(TEXT("POST"), TEXT("/v1/auth/login"), B, true, [this](const FMVWBackendResult& R)
	{
		if (R.Status == 401 && !bRetriedFresh)
		{
			// The saved account no longer exists (database was reset). Start over with a new dev account.
			bRetriedFresh = true;
			StartSession(true);
			return;
		}
		if (!R.Ok() || !R.Json.IsValid()) { Say(TEXT("Login failed: ") + Friendly(R), FColor::Red); return; }
		PlayerToken = R.Json->GetStringField(TEXT("token"));
		DoEnsureCharacter(0);
	});
}

void UMVWMapleCourtSubsystem::DoEnsureCharacter(int32 Attempt)
{
	Call(TEXT("GET"), TEXT("/v1/characters"), nullptr, true, [this, Attempt](const FMVWBackendResult& R)
	{
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if (R.Ok() && R.Json.IsValid() && R.Json->TryGetArrayField(TEXT("characters"), List) && List->Num() > 0)
		{
			CharacterId = (*List)[0]->AsObject()->GetStringField(TEXT("characterId"));
			DoTicketAndRedeem();
			return;
		}
		if (Attempt > 4) { Say(TEXT("Could not create a character: ") + Friendly(R), FColor::Red); return; }

		TSharedPtr<FJsonObject> Appearance = NewBody();
		Appearance->SetStringField(TEXT("bodyPreset"), TEXT("body_a"));
		Appearance->SetNumberField(TEXT("skinTone"), 2);
		Appearance->SetStringField(TEXT("hairstyle"), TEXT("short"));
		Appearance->SetStringField(TEXT("hairColor"), TEXT("brown"));
		Appearance->SetStringField(TEXT("outfit"), TEXT("casual_1"));
		TSharedPtr<FJsonObject> B = NewBody();
		B->SetStringField(TEXT("displayName"), TEXT("Maple Tester ") + RandomDigits(4));
		B->SetObjectField(TEXT("appearance"), Appearance);
		Call(TEXT("POST"), TEXT("/v1/characters"), B, true, [this, Attempt](const FMVWBackendResult& R2)
		{
			if (!R2.Ok()) { DoEnsureCharacter(Attempt + 1); return; } // name clash: retry with a new random name
			DoEnsureCharacter(Attempt + 1); // list again so there is a single code path that reads the id
		});
	});
}

void UMVWMapleCourtSubsystem::DoTicketAndRedeem()
{
	Call(TEXT("POST"), FString::Printf(TEXT("/v1/characters/%s/join-ticket"), *CharacterId), NewBody(), true, [this](const FMVWBackendResult& R)
	{
		if (!R.Ok() || !R.Json.IsValid()) { Say(TEXT("Join ticket refused: ") + Friendly(R), FColor::Red); return; }
		TSharedPtr<FJsonObject> B = NewBody();
		B->SetStringField(TEXT("ticket"), R.Json->GetStringField(TEXT("ticket")));
		// The ticket flow is the production way in: the server proves which character this connection owns.
		Call(TEXT("POST"), TEXT("/v1/game/tickets/redeem"), B, false, [this](const FMVWBackendResult& R2)
		{
			if (!R2.Ok() || !R2.Json.IsValid()) { Say(TEXT("Join failed: ") + Friendly(R2), FColor::Red); return; }
			ApplySummary(R2.Json);
			bSessionReady = true;
			DoPickProperty();
			Say(FString::Printf(TEXT("Welcome to Maple Court, %s! Walk to the glowing labels. E / R keys to interact."), *DisplayName), FColor::Green);
		});
	});
}

void UMVWMapleCourtSubsystem::DoPickProperty()
{
	Call(TEXT("GET"), TEXT("/v1/game/world/properties"), nullptr, false, [this](const FMVWBackendResult& R)
	{
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if (!R.Ok() || !R.Json.IsValid() || !R.Json->TryGetArrayField(TEXT("properties"), List)) { return; }
		// Prefer the home this character already rents; otherwise the first free room.
		for (const TSharedPtr<FJsonValue>& V : *List)
		{
			const TSharedPtr<FJsonObject> P = V->AsObject();
			const FString Id = P->GetStringField(TEXT("propertyId"));
			const bool bAvailable = P->GetBoolField(TEXT("available"));
			if ((!TenantPropertyId.IsEmpty() && Id == TenantPropertyId) || (TenantPropertyId.IsEmpty() && bAvailable && P->GetStringField(TEXT("type")) == TEXT("room")))
			{
				DoorPropertyId = Id;
				DoorPropertyName = P->GetStringField(TEXT("name"));
				DoorRent = (int64)P->GetNumberField(TEXT("rentPerPeriod"));
				return;
			}
		}
	});
}

void UMVWMapleCourtSubsystem::RefreshSummary()
{
	Call(TEXT("GET"), CharPath(TEXT("/summary")), nullptr, false, [this](const FMVWBackendResult& R)
	{
		if (R.Ok() && R.Json.IsValid()) { ApplySummary(R.Json); }
	});
}

void UMVWMapleCourtSubsystem::ApplySummary(const TSharedPtr<FJsonObject>& S)
{
	DisplayName = S->GetStringField(TEXT("displayName"));
	Balance = (int64)S->GetNumberField(TEXT("balance"));

	const TSharedPtr<FJsonObject>* Tenancy = nullptr;
	if (S->TryGetObjectField(TEXT("tenancy"), Tenancy))
	{
		TenantPropertyId = (*Tenancy)->GetStringField(TEXT("propertyId"));
		HomeText = FString::Printf(TEXT("%s (%s)"), *(*Tenancy)->GetStringField(TEXT("propertyName")), *(*Tenancy)->GetStringField(TEXT("status")));
	}
	else
	{
		TenantPropertyId.Reset();
		HomeText = TEXT("none yet");
	}

	BackpackText.Reset();
	const TArray<TSharedPtr<FJsonValue>>* Inv = nullptr;
	if (S->TryGetArrayField(TEXT("inventory"), Inv))
	{
		for (const TSharedPtr<FJsonValue>& V : *Inv)
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			if (!BackpackText.IsEmpty()) { BackpackText += TEXT(", "); }
			BackpackText += FString::Printf(TEXT("%d x %s"), (int32)O->GetNumberField(TEXT("quantity")), *O->GetStringField(TEXT("itemId")).Replace(TEXT("_"), TEXT(" ")));
		}
	}
	if (BackpackText.IsEmpty()) { BackpackText = TEXT("empty"); }

	const TSharedPtr<FJsonObject>* Shift = nullptr;
	if (S->TryGetObjectField(TEXT("activeShift"), Shift))
	{
		ShiftId = (*Shift)->GetStringField(TEXT("shiftId"));
		ShiftDone = (int32)(*Shift)->GetNumberField(TEXT("tasksDone"));
		ShiftRequired = (int32)(*Shift)->GetNumberField(TEXT("tasksRequired"));
		ShiftText = FString::Printf(TEXT("shift in progress, %d of %d tasks done"), ShiftDone, ShiftRequired);
	}
	else
	{
		ShiftId.Reset(); ShiftDone = 0; ShiftRequired = 0;
		ShiftText = TEXT("no shift");
	}
}

// =====================================================================================================================
// actions (each one asks the backend; the backend decides)
// =====================================================================================================================

void UMVWMapleCourtSubsystem::OnDoorUse()
{
	if (DoorPropertyId.IsEmpty()) { Say(TEXT("No rooms are free right now."), FColor::Yellow); return; }
	bBusy = true;
	Call(TEXT("GET"), FString::Printf(TEXT("/v1/game/properties/%s/access/%s"), *DoorPropertyId, *CharacterId), nullptr, false, [this](const FMVWBackendResult& R)
	{
		bool bAllowed = false;
		if (R.Ok() && R.Json.IsValid()) { R.Json->TryGetBoolField(TEXT("allowed"), bAllowed); }
		if (bAllowed)
		{
			SetDoorOpen(true);
			Say(TEXT("Door unlocked. Welcome home!"), FColor::Green);
			bBusy = false;
			return;
		}
		if (!R.Ok()) { Say(Friendly(R), FColor::Red); bBusy = false; return; }

		// Not a tenant yet: rent it (the backend charges the wallet and refuses if funds are short).
		TSharedPtr<FJsonObject> B = NewBody();
		B->SetStringField(TEXT("propertyId"), DoorPropertyId);
		B->SetStringField(TEXT("idempotencyKey"), UMVWBackendSubsystem::NewIdempotencyKey());
		Call(TEXT("POST"), CharPath(TEXT("/rent")), B, false, [this](const FMVWBackendResult& R2)
		{
			if (R2.Ok())
			{
				SetDoorOpen(true);
				Say(FString::Printf(TEXT("You rented %s! Door unlocked."), *DoorPropertyName), FColor::Green);
				RefreshSummary();
			}
			else
			{
				Say(Friendly(R2), FColor::Red);
			}
			bBusy = false;
		});
	});
}

void UMVWMapleCourtSubsystem::OnBuy(const FString& ItemId, const FString& Label)
{
	bBusy = true;
	TSharedPtr<FJsonObject> B = NewBody();
	B->SetStringField(TEXT("itemId"), ItemId);
	B->SetNumberField(TEXT("quantity"), 1);
	B->SetStringField(TEXT("idempotencyKey"), UMVWBackendSubsystem::NewIdempotencyKey());
	Call(TEXT("POST"), CharPath(FString::Printf(TEXT("/shops/%s/purchase"), GroceryShopId)), B, false, [this, Label](const FMVWBackendResult& R)
	{
		if (R.Ok() && R.Json.IsValid())
		{
			Say(FString::Printf(TEXT("Bought %s for %d MVC."), *Label, (int32)R.Json->GetNumberField(TEXT("totalPrice"))), FColor::Green);
			RefreshSummary();
		}
		else
		{
			Say(Friendly(R), FColor::Red);
		}
		bBusy = false;
	});
}

void UMVWMapleCourtSubsystem::OnWorkUse()
{
	bBusy = true;
	if (ShiftId.IsEmpty())
	{
		TSharedPtr<FJsonObject> B = NewBody();
		B->SetStringField(TEXT("jobId"), GroceryJobId);
		Call(TEXT("POST"), CharPath(TEXT("/shifts")), B, false, [this](const FMVWBackendResult& R)
		{
			if (R.Ok()) { Say(TEXT("Shift started! Do your tasks here (about 20 seconds apart)."), FColor::Green); RefreshSummary(); }
			else { Say(Friendly(R), FColor::Red); }
			bBusy = false;
		});
		return;
	}

	const FString Sid = ShiftId;
	Call(TEXT("POST"), CharPath(FString::Printf(TEXT("/shifts/%s/task"), *Sid)), NewBody(), false, [this, Sid](const FMVWBackendResult& R)
	{
		if (!R.Ok() || !R.Json.IsValid()) { Say(Friendly(R), FColor::Yellow); bBusy = false; return; }
		const int32 Done = (int32)R.Json->GetNumberField(TEXT("tasksDone"));
		const int32 Required = (int32)R.Json->GetNumberField(TEXT("tasksRequired"));
		if (Done < Required)
		{
			Say(FString::Printf(TEXT("Task %d of %d done."), Done, Required), FColor::Green);
			RefreshSummary();
			bBusy = false;
			return;
		}
		// Last task finished: ask the backend to close the shift and pay the wage.
		Call(TEXT("POST"), CharPath(FString::Printf(TEXT("/shifts/%s/complete"), *Sid)), NewBody(), false, [this](const FMVWBackendResult& R2)
		{
			if (R2.Ok() && R2.Json.IsValid()) { Say(FString::Printf(TEXT("Shift complete! You earned %d MVC."), (int32)R2.Json->GetNumberField(TEXT("wage"))), FColor::Green); }
			else { Say(Friendly(R2), FColor::Red); }
			RefreshSummary();
			bBusy = false;
		});
	});
}
